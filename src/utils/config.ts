import xsenv from '@sap/xsenv';

export class Config {
    private config: Map<string, unknown> = new Map();

    constructor() {
        this.loadConfiguration();
    }

    private loadConfiguration(): void {
        // Load from environment variables
        this.config.set('sap.destinationName', process.env.SAP_DESTINATION_NAME || 'SAP_SYSTEM');
        this.config.set('sap.discoveryDestinationName', process.env.SAP_DISCOVERY_DESTINATION_NAME);
        this.config.set('sap.executionDestinationName', process.env.SAP_EXECUTION_DESTINATION_NAME);
        this.config.set('request.timeout', parseInt(process.env.REQUEST_TIMEOUT || '30000'));
        this.config.set('request.retries', parseInt(process.env.REQUEST_RETRIES || '3'));
        this.config.set('log.level', process.env.LOG_LEVEL || 'info');
        this.config.set('node.env', process.env.NODE_ENV || 'development');

        // OAuth configuration
        // this.config.set('oauth.redirectBaseUrl', process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3000');

        // OData service discovery configuration
        this.loadODataServiceConfig();

        // Load from VCAP services if available
        try {
            xsenv.loadEnv();
            const vcapServices = process.env.VCAP_SERVICES ? JSON.parse(process.env.VCAP_SERVICES) : {};
            this.config.set('vcap.services', vcapServices);
        } catch (error) {
            console.warn('Failed to load VCAP services:', error);
        }
    }

    private loadODataServiceConfig(): void {
        // OData service filtering configuration
        // Can be set via environment variables or will use defaults

        // Service patterns - supports glob patterns and regex
        const servicePatterns = process.env.ODATA_SERVICE_PATTERNS;
        if (servicePatterns) {
            try {
                // Try parsing as JSON array first
                const patterns = JSON.parse(servicePatterns);
                this.config.set('odata.servicePatterns', Array.isArray(patterns) ? patterns : [patterns]);
            } catch {
                // Fallback to comma-separated string
                this.config.set('odata.servicePatterns', servicePatterns.split(',').map(p => p.trim()));
            }
        } else {
            // Default patterns - include all services
            this.config.set('odata.servicePatterns', ['*']);
        }

        // Service exclusion patterns
        const exclusionPatterns = process.env.ODATA_EXCLUSION_PATTERNS;
        if (exclusionPatterns) {
            try {
                const patterns = JSON.parse(exclusionPatterns);
                this.config.set('odata.exclusionPatterns', Array.isArray(patterns) ? patterns : [patterns]);
            } catch {
                this.config.set('odata.exclusionPatterns', exclusionPatterns.split(',').map(p => p.trim()));
            }
        } else {
            this.config.set('odata.exclusionPatterns', []);
        }

        // Allow all services flag - if true, ignores patterns and includes all
        this.config.set('odata.allowAllServices', process.env.ODATA_ALLOW_ALL === 'true' || process.env.ODATA_ALLOW_ALL === '*');

        // Discovery mode: 'all', 'whitelist', 'regex'
        this.config.set('odata.discoveryMode', process.env.ODATA_DISCOVERY_MODE || 'whitelist');

        // Maximum services to discover (prevents overwhelming the system)
        this.config.set('odata.maxServices', parseInt(process.env.ODATA_MAX_SERVICES || '50'));
    }

    get<T = string>(key: string, defaultValue?: T): T {
        const value = this.config.get(key);
        if (value === undefined) {
            return defaultValue as T;
        }
        return value as T;
    }

    set(key: string, value: unknown): void {
        this.config.set(key, value);
    }

    has(key: string): boolean {
        return this.config.has(key);
    }

    getAll(): Record<string, unknown> {
        return Object.fromEntries(this.config);
    }

    /**
     * Check if a service ID matches the configured patterns
     */
    isServiceAllowed(serviceId: string): boolean {
        const allowAll = this.get('odata.allowAllServices', false);
        if (allowAll) {
            return true;
        }

    // discoveryMode is not used, so removed for cleanup
        const servicePatterns = this.get('odata.servicePatterns', []);
        const exclusionPatterns = this.get('odata.exclusionPatterns', []);

        // Check exclusion patterns first
        if (this.matchesAnyPattern(serviceId, exclusionPatterns)) {
            return false;
        }

        // If no inclusion patterns are defined, allow all (unless excluded)
        if (!servicePatterns || servicePatterns.length === 0) {
            return true;
        }

        // Check inclusion patterns
        return this.matchesAnyPattern(serviceId, servicePatterns);
    }

    /**
     * Check if a string matches any of the given patterns
     * Supports glob-style patterns (* and ?) and basic regex
     */
    private matchesAnyPattern(value: string, patterns: string[]): boolean {
        return patterns.some(pattern => this.matchesPattern(value, pattern));
    }

    /**
     * Check if a string matches a pattern
     * Supports:
     * - Exact match
     * - Glob patterns with * (matches any characters) and ? (matches single character)
     * - Regex patterns (if they start and end with /)
     */
    private matchesPattern(value: string, pattern: string): boolean {
        if (!pattern) return false;

        // Exact match
        if (pattern === value) return true;

        // Regex pattern (enclosed in forward slashes)
        if (pattern.startsWith('/') && pattern.endsWith('/')) {
            try {
                const regex = new RegExp(pattern.slice(1, -1), 'i');
                return regex.test(value);
            } catch (error) {
                console.warn(`Invalid regex pattern: ${pattern}`, error);
                return false;
            }
        }

        // Glob pattern - convert to regex
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
            .replace(/\*/g, '.*') // * matches any characters
            .replace(/\?/g, '.'); // ? matches single character

        try {
            const regex = new RegExp(`^${regexPattern}$`, 'i');
            return regex.test(value);
        } catch (error) {
            console.warn(`Invalid glob pattern: ${pattern}`, error);
            return false;
        }
    }

    /**
     * Get the maximum number of services to discover
     */
    getMaxServices(): number {
        return this.get('odata.maxServices', 50);
    }

    /**
     * Maximum number of items returned in a single read response.
     * Hard cap applied after SAP returns results — excess items are truncated.
     */
    getMaxResponseItems(): number {
        return parseInt(process.env.MAX_RESPONSE_ITEMS || '100', 10);
    }

    /**
     * Soft cap on serialized response size in bytes.
     * When exceeded a warning is appended but the response is not truncated.
     */
    getMaxResponseBytes(): number {
        return parseInt(process.env.MAX_RESPONSE_BYTES || '102400', 10);
    }

    /**
     * Get service filtering configuration for logging/debugging
     */
    getServiceFilterConfig(): Record<string, unknown> {
        return {
            allowAllServices: this.get('odata.allowAllServices', false),
            discoveryMode: this.get('odata.discoveryMode', 'whitelist'),
            servicePatterns: this.get('odata.servicePatterns', []),
            exclusionPatterns: this.get('odata.exclusionPatterns', []),
            maxServices: this.get('odata.maxServices', 50)
        };
    }
}