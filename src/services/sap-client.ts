import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { HttpDestination } from '@sap-cloud-sdk/connectivity';
import { DestinationService } from './destination-service.js';
import { Logger } from '../utils/logger.js';
import { Config } from '../utils/config.js';
import { convertSapDatesInResponse, isDateConversionEnabled } from '../utils/odata-date.js';


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
            timeout: 30000,
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

            if (isDateConversionEnabled() && response.data) {
                response.data = convertSapDatesInResponse(response.data);
            }

            return response;

        } catch (error) {
            this.logger.error(`Request failed:`, error);
            throw this.handleError(error);
        }
    }

    async countEntitySet(servicePath: string, entitySet: string, filter?: string): Promise<number> {
        let url = `${servicePath}${entitySet}/$count`;
        if (filter) {
            url += `?$filter=${encodeURIComponent(filter)}`;
        }
        const response = await this.executeRequest({
            method: 'GET',
            url,
            isDiscovery: false,
            headers: { 'Accept': 'text/plain' }
        });
        const count = parseInt(String(response.data), 10);
        if (isNaN(count)) {
            throw new Error(`Unexpected /$count response: ${JSON.stringify(response.data)}`);
        }
        return count;
    }

    async readEntitySet(servicePath: string, entitySet: string, queryOptions?: Record<string, unknown>, isDiscovery = false, odataVersion: 'v2' | 'v4' = 'v2') {
        let url = `${servicePath}${entitySet}`;

        if (queryOptions) {
            // Translate v2-style $inlinecount to v4-style $count when needed
            const normalizedOptions = { ...queryOptions };
            if (odataVersion === 'v4' && normalizedOptions.$inlinecount) {
                delete normalizedOptions.$inlinecount;
                normalizedOptions.$count = 'true';
            }

            const params = new URLSearchParams();
            Object.entries(normalizedOptions).forEach(([key, value]) => {
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
        const { token, cookies } = await this.fetchCsrfToken(await this.getExecutionDestination(), servicePath);

        return this.executeRequest({
            method: 'POST',
            url,
            data,
            headers: { 'X-CSRF-Token': token, ...(cookies ? { 'Cookie': cookies } : {}) }
        });
    }

    async updateEntity(servicePath: string, entitySet: string, key: string, data: unknown) {
        const url = `${servicePath}${entitySet}(${key})`;
        const { token, cookies } = await this.fetchCsrfToken(await this.getExecutionDestination(), servicePath);

        return this.executeRequest({
            method: 'PATCH',
            url,
            data,
            headers: { 'X-CSRF-Token': token, ...(cookies ? { 'Cookie': cookies } : {}) }
        });
    }

    async callFunction(
        servicePath: string,
        functionName: string,
        parameters: Record<string, unknown>,
        httpMethod: 'GET' | 'POST'
    ) {
        if (httpMethod === 'POST') {
            const url = `${servicePath}${functionName}`;
            const { token, cookies } = await this.fetchCsrfToken(await this.getExecutionDestination(), servicePath);
            return this.executeRequest({
                method: 'POST',
                url,
                data: parameters,
                headers: { 'X-CSRF-Token': token, ...(cookies ? { 'Cookie': cookies } : {}) }
            });
        }

        // GET: serialize parameters as OData-typed query string values
        let url = `${servicePath}${functionName}`;
        if (Object.keys(parameters).length > 0) {
            const params = new URLSearchParams();
            Object.entries(parameters).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    // Wrap strings in single quotes as per OData v2 literal syntax
                    const serialized = typeof value === 'string' ? `'${value}'` : String(value);
                    params.set(key, serialized);
                }
            });
            url += `?${params.toString()}`;
        }
        return this.executeRequest({ method: 'GET', url, isDiscovery: false });
    }

    async deleteEntity(servicePath: string, entitySet: string, key: string) {
        const url = `${servicePath}${entitySet}(${key})`;
        const { token, cookies } = await this.fetchCsrfToken(await this.getExecutionDestination(), servicePath);

        return this.executeRequest({
            method: 'DELETE',
            url,
            headers: { 'X-CSRF-Token': token, ...(cookies ? { 'Cookie': cookies } : {}) }
        });
    }

    private async fetchCsrfToken(destination: HttpDestination, servicePath: string): Promise<{ token: string; cookies: string }> {
        try {
            this.logger.debug(`Fetching CSRF token from ${servicePath}`);
            const response = await executeHttpRequest(destination as HttpDestination, {
                method: 'GET',
                url: servicePath,
                timeout: 30000,
                headers: {
                    'X-CSRF-Token': 'Fetch',
                    'Accept': 'application/json'
                }
            });
            const token = response.headers['x-csrf-token'];
            this.logger.debug(`CSRF token response: status=${response.status}, token=${token ? token.toString().substring(0, 20) + '...' : 'MISSING'}`);
            if (!token) {
                throw new Error('No X-CSRF-Token returned by the server');
            }
            // Capture session cookies so the PATCH uses the same SAP session as the token fetch
            const setCookie = response.headers['set-cookie'];
            const cookies = Array.isArray(setCookie)
                ? setCookie.map((c: string) => c.split(';')[0]).join('; ')
                : (setCookie ? (setCookie as string).split(';')[0] : '');
            this.logger.debug(`Session cookies captured: ${cookies ? cookies.substring(0, 60) + '...' : 'NONE'}`);
            return { token: token as string, cookies };
        } catch (error) {
            this.logger.error('Failed to fetch CSRF token:', error);
            throw error;
        }
    }

    private handleError(error: unknown): Error {
        if (typeof error === 'object' && error !== null) {
            const err = error as Record<string, unknown>;

            // SAP Cloud SDK may wrap the error (rootCause.response)
            // or the underlying axios error may be thrown directly (response at top level).
            // Check both to reliably extract the SAP OData error body.
            const response =
                (err['rootCause'] as Record<string, unknown> | undefined)?.['response'] as Record<string, unknown> | undefined
                ?? err['response'] as Record<string, unknown> | undefined;

            if (response) {
                const status = response['status'];
                const statusText = response['statusText'];

                // response.data may be a Buffer (if axios didn't auto-parse JSON),
                // a plain string (JSON not yet parsed), or an already-parsed object.
                let data: {
                    error?: {
                        code?: string;
                        // SAP OData V2: message is an object {lang, value}, not a plain string
                        message?: string | { lang?: string; value?: string };
                        innererror?: {
                            errordetails?: Array<{
                                code?: string;
                                message?: string | { lang?: string; value?: string };
                                severity?: string;
                            }>;
                        };
                    };
                } | undefined;

                const rawData = response['data'];
                if (Buffer.isBuffer(rawData)) {
                    try { data = JSON.parse(rawData.toString('utf8')); } catch { data = undefined; }
                } else if (typeof rawData === 'string') {
                    try { data = JSON.parse(rawData); } catch { data = undefined; }
                } else {
                    data = rawData as typeof data;
                }

                let errorMsg = `SAP API Error ${status}`;

                if (data?.error) {
                    const errObj = data.error;
                    const mainMsg = typeof errObj.message === 'string'
                        ? errObj.message
                        : errObj.message?.value;

                    if (mainMsg) {
                        errorMsg += `: ${mainMsg}`;
                    }

                    // Include all error details from innererror.errordetails
                    const details = errObj.innererror?.errordetails;
                    if (details && details.length > 0) {
                        const detailMsgs = details
                            .map(d => {
                                const msg = typeof d.message === 'string' ? d.message : d.message?.value;
                                return msg ? (d.code ? `[${d.code}] ${msg}` : msg) : null;
                            })
                            .filter((m): m is string => m !== null);
                        if (detailMsgs.length > 0) {
                            errorMsg += `\nDetails:\n${detailMsgs.join('\n')}`;
                        }
                    }
                } else {
                    errorMsg += `: ${statusText}`;
                }

                this.logger.error(`SAP error extracted: ${errorMsg}`);
                return new Error(errorMsg);
            }
        }
        return error instanceof Error ? error : new Error(String(error));
    }
}
