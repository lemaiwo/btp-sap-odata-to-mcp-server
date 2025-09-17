import { getDestination, HttpDestination } from '@sap-cloud-sdk/connectivity';
import xsenv from '@sap/xsenv';
import { Logger } from '../utils/logger.js';
import { Config } from '../utils/config.js';

export class DestinationService {
    private config: Config;
    private vcapServices!: Record<string, unknown>;

    constructor(
        private logger: Logger,
        config?: Config
    ) {
        this.config = config || new Config();
    }

    async initialize(): Promise<void> {
        // Load VCAP services if available, but don't fail locally when not bound
        try {
            // Load VCAP services
            xsenv.loadEnv();

            try {
                this.vcapServices = xsenv.getServices({
                    destination: { label: 'destination' },
                    connectivity: { label: 'connectivity' },
                    xsuaa: { label: 'xsuaa' }
                });
                this.logger.info('Destination service initialized successfully (BTP services detected)');
            } catch (serviceError) {
                // No matching services in local mode - proceed with env-based destinations
                this.vcapServices = {};
                this.logger.warn('No BTP Destination/Connectivity/XSUAA services found. Continuing with environment-based destinations.');
            }

        } catch (error) {
            // Even loading env failed - continue with empty services for local usage
            this.vcapServices = {};
            this.logger.warn('Failed to load VCAP services. Continuing with environment-based destinations.');
        }
    }

    /**
     * Get destination for API discovery (uses technical user)
     */
    async getDiscoveryDestination(): Promise<HttpDestination> {
        const destinationName = this.config.get('sap.discoveryDestinationName',
            this.config.get('sap.destinationName', 'SAP_SYSTEM'));

        this.logger.debug(`Fetching discovery destination: ${destinationName}`);
        return this.getDestination(destinationName, undefined);
    }

    /**
     * Get destination for API execution (uses JWT token if provided)
     */
    async getExecutionDestination(jwtToken?: string): Promise<HttpDestination> {
        const destinationName = this.config.get('sap.executionDestinationName',
            this.config.get('sap.destinationName', 'SAP_SYSTEM'));

        this.logger.debug(`Fetching execution destination: ${destinationName}`);
        return this.getDestination(destinationName, jwtToken);
    }

    /**
     * Legacy method for backward compatibility
     */
    async getSAPDestination(): Promise<HttpDestination> {
        return this.getDiscoveryDestination();
    }

    /**
     * Internal method to get destination with optional JWT
     */
    private async getDestination(destinationName: string, jwtToken?: string): Promise<HttpDestination> {
        this.logger.debug(`Fetching destination: ${destinationName} ${jwtToken ? 'with JWT' : 'without JWT'}`);

        try {
            // First try environment variables (for local development)
            const envDestinations = process.env.destinations || process.env.DESTINATIONS;
            if (envDestinations) {
                const destinations = JSON.parse(envDestinations);

                // Try to find by configured name
                const envDest = destinations.find((d: Record<string, unknown>) => d.name === destinationName);
                if (envDest) {
                    this.logger.info(`Successfully retrieved destination '${destinationName}' from environment variable.`);
                    return {
                        url: envDest.url,
                        username: envDest.username,
                        password: envDest.password,
                        authentication: 'BasicAuthentication'
                    } as HttpDestination;
                }

                // Fallback: If only one destination is defined, use it regardless of name
                if (Array.isArray(destinations) && destinations.length === 1) {
                    const single = destinations[0] as Record<string, unknown>;
                    this.logger.info(`Using the only configured environment destination '${single.name as string}'.`);
                    return {
                        url: single.url as string,
                        username: single.username as string,
                        password: single.password as string,
                        authentication: 'BasicAuthentication'
                    } as HttpDestination;
                }
            }
        } catch (envError) {
            this.logger.debug('Failed to load from environment destinations:', envError);
        }

        try {
            // Use SAP Cloud SDK getDestination with optional JWT
            const destination = await getDestination({
                destinationName,
                jwt: jwtToken || this.getJWT()
            });
            if (!destination) {
                throw new Error(`Destination '${destinationName}' not found in environment variables or BTP destination service`);
            }
            this.logger.info(`Successfully retrieved destination: ${destinationName}`);
            return destination as HttpDestination;
        } catch (error) {
            this.logger.error('Failed to get SAP destination:', error);
            throw error;
        }
    }

    private getJWT(): string | undefined {
        // In a real application, this would extract JWT from the current request
        // For technical user scenario, this might not be needed
        return process.env.USER_JWT || undefined;
    }

    getDestinationCredentials() {
        return (this.vcapServices?.destination as { credentials?: unknown })?.credentials;
    }

    getConnectivityCredentials() {
        return (this.vcapServices?.connectivity as { credentials?: unknown })?.credentials;
    }

    getXSUAACredentials() {
        return (this.vcapServices?.xsuaa as { credentials?: unknown })?.credentials;
    }
}