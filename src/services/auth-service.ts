import xssec from '@sap/xssec';
import xsenv from '@sap/xsenv';
import { Request, Response, NextFunction } from 'express';
import { Logger } from '../utils/logger.js';
import { Config } from '../utils/config.js';

export interface AuthRequest extends Request {
    authInfo?: xssec.SecurityContext;
    jwtToken?: string;
}

export class AuthService {
    private xsuaaCredentials: Record<string, unknown> | null = null;
    private logger: Logger;
    private config: Config;

    constructor(logger?: Logger, config?: Config) {
        this.logger = logger || new Logger('AuthService');
        this.config = config || new Config();
        this.initializeXSUAA();
    }

    private initializeXSUAA(): void {
        try {
            xsenv.loadEnv();
            const services = xsenv.getServices({
                xsuaa: { label: 'xsuaa' }
            });
            this.xsuaaCredentials = services.xsuaa as Record<string, unknown>;
            this.logger.info('XSUAA service initialized successfully');
        } catch {
            this.logger.warn('XSUAA service not found in VCAP_SERVICES, OAuth will be disabled');
            this.xsuaaCredentials = null;
        }
    }

    /**
     * Generate OAuth authorization URL for user login
     */
    getAuthorizationUrl(state?: string, requestUrl?: string): string {
        if (!this.xsuaaCredentials) {
            throw new Error('XSUAA service not configured');
        }

        const creds = this.xsuaaCredentials as Record<string, string>;
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: creds.clientid,
            redirect_uri: this.getRedirectUri(requestUrl),
            ...(state && { state })
        });

        return `${creds.url}/oauth/authorize?${params.toString()}`;
    }

    /**
     * Exchange authorization code for access token
     */
    async exchangeCodeForToken(code: string, redirectUri?: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
        if (!this.xsuaaCredentials) {
            throw new Error('XSUAA service not configured');
        }
        const creds = this.xsuaaCredentials as Record<string, string>;
        const tokenUrl = `${creds.url}/oauth/token`;
        const params = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: creds.clientid,
            client_secret: creds.clientsecret,
            redirect_uri: redirectUri || this.getRedirectUri()
        });

        try {
            const response = await fetch(tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                body: params.toString()
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
            }

            const tokenData = await response.json();
            return tokenData;
        } catch (error) {
            this.logger.error('Failed to exchange code for token:', error);
            throw error;
        }
    }

    /**
     * Refresh an access token using a refresh token
     */
    async refreshAccessToken(refreshToken: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number; token_type?: string }> {
        if (!this.xsuaaCredentials) {
            throw new Error('XSUAA service not configured');
        }

        const creds = this.xsuaaCredentials as Record<string, string>;
        const tokenUrl = `${creds.url}/oauth/token`;
        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: creds.clientid,
            client_secret: creds.clientsecret
        });

        try {
            const response = await fetch(tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                body: params.toString()
            });

            if (!response.ok) {
                const errorText = await response.text();
                this.logger.error(`Token refresh HTTP error: ${response.status} - ${errorText}`);
                throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
            }

            const tokenData = await response.json();
            this.logger.info('Token refresh successful');

            // Return the token data in the same format as XSUAA (snake_case)
            return {
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                expires_in: tokenData.expires_in,
                token_type: tokenData.token_type || 'bearer'
            };
        } catch (error) {
            this.logger.error('Failed to refresh token:', error);
            throw error;
        }
    }

    /**
     * Validate JWT token and extract user information
     */
    async validateToken(token: string): Promise<xssec.SecurityContext> {
        if (!this.xsuaaCredentials) {
            throw new Error('XSUAA service not configured');
        }

        return new Promise((resolve, reject) => {
            xssec.createSecurityContext(token, this.xsuaaCredentials as Record<string, unknown>, (error: Error | null, securityContext?: xssec.SecurityContext) => {
                if (error) {
                    this.logger.error('Token validation failed:', error);
                    reject(error);
                } else if (securityContext) {
                    resolve(securityContext);
                } else {
                    reject(new Error('Security context creation failed'));
                }
            });
        });
    }

    /**
     * Express middleware for JWT authentication
     * Extracts and validates JWT token from Authorization header
     */
    authenticateJWT() {
        return async (req: AuthRequest, res: Response, next: NextFunction) => {
            // Skip authentication for health and docs endpoints
            if (req.path === '/health' || req.path === '/docs' || req.path === '/oauth/authorize' || req.path === '/oauth/callback') {
                return next();
            }

            // Skip if XSUAA is not configured (development mode)
            if (!this.xsuaaCredentials) {
                this.logger.debug('XSUAA not configured, skipping authentication');
                return next();
            }

            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                return res.status(401).json({
                    error: 'Authentication Required',
                    message: 'This SAP OData MCP server requires OAuth 2.0 authentication',
                    authentication: {
                        required: true,
                        type: 'Bearer Token',
                        instructions: {
                            step1: `Navigate to ${baseUrl}/oauth/authorize to start OAuth flow`,
                            step2: 'Login with your SAP BTP credentials',
                            step3: 'Copy the access token from the callback response',
                            step4: 'Include token in Authorization header: Bearer <your-token>'
                        },
                        endpoints: {
                            authorize: `${baseUrl}/oauth/authorize`,
                            userinfo: `${baseUrl}/oauth/userinfo`,
                            refresh: `${baseUrl}/oauth/refresh`,
                            discovery: `${baseUrl}/.well-known/oauth-authorization-server`
                        }
                    },
                    mcp_context: {
                        message: 'All MCP operations require authenticated SAP user context',
                        dual_auth_model: {
                            discovery: 'Uses technical user for service discovery',
                            execution: 'Uses your JWT token for data operations'
                        }
                    }
                });
            }

            const token = authHeader.substring(7);

            try {
                const securityContext = await this.validateToken(token);
                req.authInfo = securityContext;
                req.jwtToken = token;
                this.logger.debug(`Request authenticated for user: ${securityContext.getUserName()}`);
                next();
            } catch (error) {
                this.logger.error('Authentication failed:', error);
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                return res.status(401).json({
                    error: 'Token Validation Failed',
                    message: 'The provided JWT token is invalid or expired',
                    details: error instanceof Error ? error.message : 'Token validation error',
                    next_steps: {
                        if_expired: `Get a fresh token from ${baseUrl}/oauth/authorize`,
                        if_refresh_available: `Try refreshing your token at ${baseUrl}/oauth/refresh`,
                        if_invalid: 'Ensure you are using a valid SAP BTP XSUAA token'
                    },
                    authentication: {
                        endpoints: {
                            authorize: `${baseUrl}/oauth/authorize`,
                            refresh: `${baseUrl}/oauth/refresh`,
                            userinfo: `${baseUrl}/oauth/userinfo`
                        },
                        token_info: {
                            typical_lifetime: '1 hour',
                            refresh_lifetime: '24 hours',
                            issuer: (this.xsuaaCredentials as Record<string, string>)?.url || 'SAP XSUAA Service'
                        }
                    }
                });
            }
        };
    }

    /**
     * Express middleware for optional JWT authentication
     * Validates token if present but doesn't require it
     */
    optionalAuthenticateJWT() {
        return async (req: AuthRequest, res: Response, next: NextFunction) => {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return next();
            }

            if (!this.xsuaaCredentials) {
                return next();
            }

            const token = authHeader.substring(7);

            try {
                const securityContext = await this.validateToken(token);
                req.authInfo = securityContext;
                req.jwtToken = token;
                this.logger.debug(`Optional auth: Request authenticated for user: ${securityContext.getUserName()}`);
            } catch {
                this.logger.debug('Optional auth: Token validation failed, continuing without auth');
            }

            next();
        };
    }

    /**
     * Check if a user has a specific scope
     */
    hasScope(securityContext: xssec.SecurityContext, scope: string): boolean {
        return securityContext.checkScope(scope);
    }

    /**
     * Get user information from security context
     */
    getUserInfo(securityContext: xssec.SecurityContext) {
        return {
            username: securityContext.getUserName(),
            email: securityContext.getEmail(),
            givenName: securityContext.getGivenName(),
            familyName: securityContext.getFamilyName(),
            scopes: securityContext.getGrantedScopes()
        };
    }

    getRedirectUri(requestUrl?: string): string {
        const port = process.env.PORT || '3000';
        const defaultBaseUrl = `http://localhost:${port}`;
        const baseUrl = this.config.get('oauth.redirectBaseUrl', process.env.OAUTH_REDIRECT_BASE_URL || requestUrl || defaultBaseUrl);
        return `${baseUrl}/oauth/callback`;
    }

    /**
     * Check if XSUAA is configured
     */
    isConfigured(): boolean {
        return this.xsuaaCredentials !== null;
    }

    /**
     * Get XSUAA discovery metadata for OAuth endpoints
     */
    getXSUAADiscoveryMetadata() {
        if (!this.xsuaaCredentials) {
            return null;
        }

        const creds = this.xsuaaCredentials as Record<string, string>;
        return {
            issuer: creds.url,
            clientId: creds.clientid,
            xsappname: creds.xsappname,
            identityZone: creds.identityzone,
            tenantId: creds.tenantid,
            tenantMode: creds.tenantmode,
            endpoints: {
                authorization: `${creds.url}/oauth/authorize`,
                token: `${creds.url}/oauth/token`,
                userinfo: `${creds.url}/userinfo`,
                jwks: `${creds.url}/token_keys`,
                introspection: `${creds.url}/oauth/introspect`,
                revocation: `${creds.url}/oauth/revoke`
            },
            verificationKey: creds.verificationkey
        };
    }

    /**
     * Get application-specific scopes from xs-security.json configuration
     */
    getApplicationScopes(): string[] {
        const creds = this.xsuaaCredentials as Record<string, string>;
        if (!creds?.xsappname) {
            return [];
        }

        const appName = creds.xsappname;
        return [
            `${appName}.read`,
            `${appName}.write`,
            `${appName}.admin`
        ];
    }

    /**
     * Get XSUAA service information (safe for public exposure)
     */
    getServiceInfo() {
        if (!this.xsuaaCredentials) {
            return null;
        }

        const creds = this.xsuaaCredentials as Record<string, string>;
        return {
            url: creds.url,
            clientId: creds.clientid,
            xsappname: creds.xsappname,
            identityZone: creds.identityzone,
            tenantId: creds.tenantid,
            tenantMode: creds.tenantmode,
            // Don't expose sensitive credentials
            configured: true
        };
    }

    /**
     * Get XSUAA client credentials for OAuth client registration (sensitive)
     * This method should only be used internally for client registration
     */
    getClientCredentials() {
        if (!this.xsuaaCredentials) {
            return null;
        }

        const creds = this.xsuaaCredentials as Record<string, string>;
        return {
            client_id: creds.clientid,
            client_secret: creds.clientsecret,
            url: creds.url,
            identityZone: creds.identityzone,
            tenantMode: creds.tenantmode
        };
    }
}