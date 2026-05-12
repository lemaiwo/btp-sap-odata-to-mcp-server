import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { HttpDestination } from '@sap-cloud-sdk/connectivity';
import { DestinationService } from './destination-service.js';
import { Logger } from '../utils/logger.js';
import { Config } from '../utils/config.js';


export class SAPClient {
    private discoveryDestination: HttpDestination | null = null;
    private config: Config;
    private currentUserToken?: string;

    constructor(
        private destinationService: DestinationService,
        private logger: Logger
    ) {
        this.config = new Config();
    }

    /**
     * Set the current user's JWT token for subsequent operations
     */
    setUserToken(token?: string) {
        this.currentUserToken = token;
        this.logger.debug(`User token ${token ? 'set' : 'cleared'} for SAP client`);
    }

    /**
     * Get destination for discovery operations (technical user)
     */
    async getDiscoveryDestination(): Promise<HttpDestination> {
        if (!this.discoveryDestination) {
            this.discoveryDestination = await this.destinationService.getDiscoveryDestination();
        }
        return this.discoveryDestination;
    }

    /**
     * Get destination for execution operations (with JWT if available)
     */
    async getExecutionDestination(): Promise<HttpDestination> {
        return await this.destinationService.getExecutionDestination(this.currentUserToken);
    }

    /**
     * Legacy method - defaults to discovery destination
     */
    async getDestination(): Promise<HttpDestination> {
        return this.getDiscoveryDestination();
    }

    async executeRequest(options: {
        url: string;
        method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
        data?: unknown;
        headers?: Record<string, string>;
        isDiscovery?: boolean;
    }) {
        // Use discovery destination for metadata/discovery calls, execution destination for data operations
        const destination = options.isDiscovery
            ? await this.getDiscoveryDestination()
            : await this.getExecutionDestination();

        const requestOptions = {
            method: options.method,
            url: options.url,
            data: options.data,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...options.headers
            }
        };

        try {
            this.logger.debug(`Executing ${options.method} request to ${options.url}`);

            if (!destination.url) {
                throw new Error('Destination URL is not configured');
            }

            const response = await executeHttpRequest(destination as HttpDestination, requestOptions);

            this.logger.debug(`Request completed successfully`);
            return response;

        } catch (error) {
            this.logger.error(`Request failed:`, error);
            throw this.handleError(error);
        }
    }

    async readEntitySet(servicePath: string, entitySet: string, queryOptions?: {
        $filter?: string;
        $select?: string;
        $expand?: string;
        $orderby?: string;
        $top?: number;
        $skip?: number;
    }, isDiscovery = false) {
        let url = `${servicePath}${entitySet}`;

        if (queryOptions) {
            const params = new URLSearchParams();
            Object.entries(queryOptions).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    params.set(key, String(value));
                }
            });

            if (params.toString()) {
                url += `?${params.toString()}`;
            }
        }

        return this.executeRequest({
            method: 'GET',
            url,
            isDiscovery
        });
    }

    async readEntity(servicePath: string, entitySet: string, key: string, isDiscovery = false) {
        const url = `${servicePath}${entitySet}(${key})`;

        return this.executeRequest({
            method: 'GET',
            url,
            isDiscovery
        });
    }

    async createEntity(servicePath: string, entitySet: string, data: unknown) {
        const url = `${servicePath}${entitySet}`;

        return this.executeRequest({
            method: 'POST',
            url,
            data
        });
    }

    async updateEntity(servicePath: string, entitySet: string, key: string, data: unknown) {
        const url = `${servicePath}${entitySet}(${key})`;

        return this.executeRequest({
            method: 'PATCH',
            url,
            data
        });
    }

    async deleteEntity(servicePath: string, entitySet: string, key: string) {
        const url = `${servicePath}${entitySet}(${key})`;

        return this.executeRequest({
            method: 'DELETE',
            url
        });
    }

    private handleError(error: unknown): Error {
        if (
            typeof error === 'object' &&
            error !== null &&
            'rootCause' in error &&
            (error as { rootCause?: { response?: { status: number; data?: unknown; statusText?: string } } }).rootCause?.response
        ) {
            const response = (error as { rootCause: { response: { status: number; data?: unknown; statusText?: string } } }).rootCause.response;
            const data = response.data as { error?: { code?: string; message?: string; details?: Array<{ code?: string; message?: string; target?: string }>; innererror?: unknown } } | undefined;
            const sapError = data?.error;

            if (sapError) {
                const parts: string[] = [];
                const mainMsg = sapError.message || response.statusText || String(response.status);
                parts.push(`SAP API Error ${response.status}: ${mainMsg}`);
                if (sapError.code) parts.push(`Code: ${sapError.code}`);
                if (Array.isArray(sapError.details) && sapError.details.length > 0) {
                    const details = sapError.details
                        .map(d => [d.target ? `[${d.target}] ` : '', d.message].join(''))
                        .filter(Boolean)
                        .join(' | ');
                    parts.push(`Details: ${details}`);
                }
                return new Error(parts.join(' — '));
            }

            return new Error(`SAP API Error ${response.status}: ${response.statusText || String(response.status)}`);
        }
        return error instanceof Error ? error : new Error(String(error));
    }
}
