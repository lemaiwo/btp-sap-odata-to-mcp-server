import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SAPClient } from "../services/sap-client.js";
import { Logger } from "../utils/logger.js";
import { ODataService, EntityType } from "../types/sap-types.js";
import { z } from "zod";

/**
 * Hierarchical Tool Registry - Solves the "tool explosion" problem
 *
 * Instead of registering hundreds of CRUD tools upfront (5 ops × 40+ entities × services),
 * this registry uses a hierarchical discovery approach with just 4 smart tools:
 * 1. search-sap-services - Find relevant services by category/keyword
 * 2. discover-service-entities - Show entities within a specific service
 * 3. get-entity-schema - Get detailed schema for an entity
 * 4. execute-entity-operation - Perform CRUD operations on any entity
 *
 * This reduces Claude's context from 200+ tools to just 4, solving token overflow.
 */
export class HierarchicalSAPToolRegistry {
    private serviceCategories = new Map<string, string[]>();
    private userToken?: string;

    constructor(
        private mcpServer: McpServer,
        private sapClient: SAPClient,
        private logger: Logger,
        private discoveredServices: ODataService[]
    ) {
        this.categorizeServices();
    }

    /**
     * Set the user's JWT token for authenticated operations
     */
    setUserToken(token?: string) {
        this.userToken = token;
        this.sapClient.setUserToken(token);
        this.logger.debug(`User token ${token ? 'set' : 'cleared'} for tool registry`);
    }

    /**
     * Register the 4 hierarchical discovery tools instead of 200+ individual CRUD tools
     */
    public async registerDiscoveryTools(): Promise<void> {
        this.logger.info(`🔧 Registering hierarchical tools for ${this.discoveredServices.length} services`);

        // Tool 1: Search and discover services
        this.mcpServer.registerTool(
            "search-sap-services",
            {
                title: "Search SAP Services",
                description: "🔐 AUTHENTICATION AWARE: Search and filter available SAP OData services by name, category, or keyword. Service discovery uses technical user, but data operations will require user authentication. Use this first to find relevant services before accessing entities.",
                inputSchema: {
                    query: z.string().optional().describe("Search term to filter services (name, title, description)"),
                    category: z.enum(["business-partner", "sales", "finance", "procurement", "hr", "logistics", "all"]).optional().describe("Service category filter"),
                    limit: z.number().min(1).max(20).default(10).describe("Maximum number of services to return")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.searchServices(args);
            }
        );

        // Tool 2: Discover entities within a specific service
        this.mcpServer.registerTool(
            "discover-service-entities",
            {
                title: "Discover Service Entities",
                description: "🔐 AUTHENTICATION AWARE: List all entities and their capabilities within a specific SAP service. Entity discovery uses technical user, but actual data access requires user authentication. Use this after finding a service to understand what data you can work with.",
                inputSchema: {
                    serviceId: z.string().describe("The SAP service ID from search-sap-services (use the 'id' field, NOT the 'title' field)"),
                    showCapabilities: z.boolean().default(true).describe("Show CRUD capabilities for each entity")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.discoverServiceEntities(args);
            }
        );

        // Tool 3: Get entity schema
        this.mcpServer.registerTool(
            "get-entity-schema",
            {
                title: "Get Entity Schema",
                description: "🔐 AUTHENTICATION AWARE: Get detailed schema information for a specific entity including properties, types, keys, and constraints. Schema access uses technical user, but data operations require user authentication.",
                inputSchema: {
                    serviceId: z.string().describe("The SAP service ID from search-sap-services (use the 'id' field, NOT the 'title' field)"),
                    entityName: z.string().describe("The entity name from discover-service-entities (use the 'name' field, NOT the 'entitySet' field)")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.getEntitySchema(args);
            }
        );

        // Tool 4: Execute operations on entities
        this.mcpServer.registerTool(
            "execute-entity-operation",
            {
                title: "Execute Entity Operation",
                description: "🔒 AUTHENTICATION REQUIRED: Perform CRUD operations on SAP entities using authenticated user context. This tool requires valid JWT token for authorization and audit trail. Use discover-service-entities first to understand available entities and their schemas. Operations execute under user's SAP identity.",
                inputSchema: {
                    serviceId: z.string().describe("The SAP service ID from search-sap-services (use the 'id' field, NOT the 'title' field)"),
                    entityName: z.string().describe("The entity name from discover-service-entities (use the 'name' field, NOT the 'entitySet' field)"),
                    operation: z.enum(["read", "read-single", "create", "update", "delete"]).describe("The operation to perform"),
                    parameters: z.record(z.any()).optional().describe("Operation parameters (keys, filters, data, etc.)"),
                    queryOptions: z.object({
                        $filter: z.string().optional(),
                        $select: z.string().optional(),
                        $expand: z.string().optional(),
                        $orderby: z.string().optional(),
                        $top: z.number().optional(),
                        $skip: z.number().optional()
                    }).optional().describe("OData query options (for read operations)"),
                    useUserToken: z.boolean().optional().describe("Use the authenticated user's token for this operation (default: true for data operations)")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.executeEntityOperation(args);
            }
        );

        this.logger.info("✅ Registered 4 hierarchical discovery tools successfully");
    }

    /**
     * Categorize services for better discovery using intelligent pattern matching
     */
    private categorizeServices(): void {
        for (const service of this.discoveredServices) {
            const categories: string[] = [];
            const id = service.id.toLowerCase();
            const title = service.title.toLowerCase();
            const desc = service.description.toLowerCase();

            // Business Partner related
            if (id.includes('business_partner') || id.includes('bp_') || id.includes('customer') || id.includes('supplier') ||
                title.includes('business partner') || title.includes('customer') || title.includes('supplier')) {
                categories.push('business-partner');
            }

            // Sales related
            if (id.includes('sales') || id.includes('order') || id.includes('quotation') || id.includes('opportunity') ||
                title.includes('sales') || title.includes('order') || desc.includes('sales')) {
                categories.push('sales');
            }

            // Finance related
            if (id.includes('finance') || id.includes('accounting') || id.includes('payment') || id.includes('invoice') ||
                id.includes('gl_') || id.includes('ar_') || id.includes('ap_') || title.includes('finance') ||
                title.includes('accounting') || title.includes('payment')) {
                categories.push('finance');
            }

            // Procurement related
            if (id.includes('purchase') || id.includes('procurement') || id.includes('vendor') || id.includes('po_') ||
                title.includes('procurement') || title.includes('purchase') || title.includes('vendor')) {
                categories.push('procurement');
            }

            // HR related
            if (id.includes('employee') || id.includes('hr_') || id.includes('personnel') || id.includes('payroll') ||
                title.includes('employee') || title.includes('human') || title.includes('personnel')) {
                categories.push('hr');
            }

            // Logistics related
            if (id.includes('logistics') || id.includes('warehouse') || id.includes('inventory') || id.includes('material') ||
                id.includes('wm_') || id.includes('mm_') || title.includes('logistics') || title.includes('material')) {
                categories.push('logistics');
            }

            // Default category if none matched
            if (categories.length === 0) {
                categories.push('all');
            }

            this.serviceCategories.set(service.id, categories);
        }

        this.logger.debug(`Categorized ${this.discoveredServices.length} services into categories`);
    }

    /**
     * Search services implementation with intelligent filtering
     */
    private async searchServices(args: Record<string, unknown>) {
        try {
            const query = (args.query as string)?.toLowerCase() || "";
            const category = args.category as string || "all";
            const limit = (args.limit as number) || 10;

            let filteredServices = this.discoveredServices;

            // Filter by category first
            if (category && category !== "all") {
                filteredServices = filteredServices.filter(service =>
                    this.serviceCategories.get(service.id)?.includes(category)
                );
            }

            // Filter by search query
            if (query) {
                filteredServices = filteredServices.filter(service =>
                    service.id.toLowerCase().includes(query) ||
                    service.title.toLowerCase().includes(query) ||
                    service.description.toLowerCase().includes(query)
                );
            }

            // Apply limit
            const totalFound = filteredServices.length;
            filteredServices = filteredServices.slice(0, limit);

            const result = {
                query: query || "all",
                category: category,
                totalFound: totalFound,
                showing: filteredServices.length,
                services: filteredServices.map(service => ({
                    id: service.id,
                    title: service.title,
                    description: service.description,
                    entityCount: service.metadata?.entityTypes?.length || 0,
                    categories: this.serviceCategories.get(service.id) || [],
                    version: service.version,
                    odataVersion: service.odataVersion
                }))
            };

            let responseText = `Found ${totalFound} SAP services`;
            if (query) responseText += ` matching "${query}"`;
            if (category !== "all") responseText += ` in category "${category}"`;
            responseText += `:\n\n${JSON.stringify(result, null, 2)}`;

            if (result.services.length > 0) {
                responseText += `\n\n📋 Next step: Use 'discover-service-entities' with the serviceId parameter set to the 'id' field (NOT the 'title' field) from the results above.`;
                responseText += `\n\n⚠️  IMPORTANT: Always use the 'id' field as serviceId, never use the 'title' field!`;
            } else {
                responseText += `\n\n💡 Try different search terms or categories: business-partner, sales, finance, procurement, hr, logistics`;
            }

            return {
                content: [{
                    type: "text" as const,
                    text: responseText
                }]
            };

        } catch (error) {
            this.logger.error('Error searching services:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `Error searching services: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }

    /**
     * Discover entities within a service with capability information
     */
    private async discoverServiceEntities(args: Record<string, unknown>) {
        try {
            const serviceId = args.serviceId as string;
            const showCapabilities = args.showCapabilities !== false;

            const service = this.discoveredServices.find(s => s.id === serviceId);
            if (!service) {
                // Check if user provided a title instead of an id
                const serviceByTitle = this.discoveredServices.find(s => s.title.toLowerCase() === serviceId.toLowerCase());
                let errorMessage = `❌ Service not found: ${serviceId}\n\n`;
                
                if (serviceByTitle) {
                    errorMessage += `⚠️  It looks like you used the 'title' field instead of the 'id' field!\n`;
                    errorMessage += `✅ Use this serviceId instead: ${serviceByTitle.id}\n\n`;
                    errorMessage += `Remember: Always use the 'id' field from search-sap-services results, NOT the 'title' field.`;
                } else {
                    errorMessage += `💡 Use 'search-sap-services' to find available services.\n`;
                    errorMessage += `⚠️  Make sure you're using the 'id' field from search results, NOT the 'title' field.`;
                }
                
                return {
                    content: [{
                        type: "text" as const,
                        text: errorMessage
                    }],
                    isError: true
                };
            }

            if (!service.metadata?.entityTypes) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `⚠️ No entities found for service: ${serviceId}. The service metadata may not have loaded properly.`
                    }]
                };
            }

            const entities = service.metadata.entityTypes.map(entity => {
                const result: {
                    name: string;
                    entitySet: string | null | undefined;
                    propertyCount: number;
                    keyProperties: string[];
                    capabilities?: {
                        readable: boolean;
                        creatable: boolean;
                        updatable: boolean;
                        deletable: boolean;
                    };
                } = {
                    name: entity.name,
                    entitySet: entity.entitySet,
                    propertyCount: entity.properties.length,
                    keyProperties: entity.keys
                };

                if (showCapabilities) {
                    result.capabilities = {
                        readable: true, // Always true for OData
                        creatable: entity.creatable,
                        updatable: entity.updatable,
                        deletable: entity.deletable
                    };
                }

                return result;
            });

            const serviceInfo = {
                service: {
                    id: serviceId,
                    title: service.title,
                    description: service.description,
                    categories: this.serviceCategories.get(service.id) || [],
                    odataVersion: service.odataVersion
                },
                entities: entities
            };

            let responseText = `📊 Service: ${service.title} (${serviceId})\n`;
            responseText += `📁 Found ${entities.length} entities\n\n`;
            responseText += JSON.stringify(serviceInfo, null, 2);
            responseText += `\n\n📋 Next steps:\n`;
            responseText += `• Use 'get-entity-schema' with entityName set to the 'name' field (NOT 'entitySet') to see detailed property information\n`;
            responseText += `• Use 'execute-entity-operation' with entityName set to the 'name' field (NOT 'entitySet') to perform CRUD operations\n`;
            responseText += `\n⚠️  IMPORTANT: Always use the 'name' field for entityName, never use the 'entitySet' field!`;

            return {
                content: [{
                    type: "text" as const,
                    text: responseText
                }]
            };

        } catch (error) {
            this.logger.error('Error discovering service entities:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `❌ Error discovering entities: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }

    /**
     * Get detailed entity schema information
     */
    private async getEntitySchema(args: Record<string, unknown>) {
        try {
            const serviceId = args.serviceId as string;
            const entityName = args.entityName as string;

            const service = this.discoveredServices.find(s => s.id === serviceId);
            if (!service) {
                // Check if user provided a title instead of an id
                const serviceByTitle = this.discoveredServices.find(s => s.title.toLowerCase() === serviceId.toLowerCase());
                let errorMessage = `❌ Service not found: ${serviceId}\n\n`;
                
                if (serviceByTitle) {
                    errorMessage += `⚠️  It looks like you used the 'title' field instead of the 'id' field!\n`;
                    errorMessage += `✅ Use this serviceId instead: ${serviceByTitle.id}\n\n`;
                    errorMessage += `Remember: Always use the 'id' field from search-sap-services results, NOT the 'title' field.`;
                } else {
                    errorMessage += `💡 Use 'search-sap-services' to find available services.\n`;
                    errorMessage += `⚠️  Make sure you're using the 'id' field from search results, NOT the 'title' field.`;
                }
                
                return {
                    content: [{
                        type: "text" as const,
                        text: errorMessage
                    }],
                    isError: true
                };
            }

            const entityType = service.metadata?.entityTypes?.find(e => e.name === entityName);
            if (!entityType) {
                const availableEntities = service.metadata?.entityTypes?.map(e => e.name).join(', ') || 'none';
                return {
                    content: [{
                        type: "text" as const,
                        text: `❌ Entity '${entityName}' not found in service '${serviceId}'\n\n📋 Available entities: ${availableEntities}`
                    }],
                    isError: true
                };
            }

            const schema = {
                entity: {
                    name: entityType.name,
                    entitySet: entityType.entitySet,
                    namespace: entityType.namespace
                },
                capabilities: {
                    readable: true,
                    creatable: entityType.creatable,
                    updatable: entityType.updatable,
                    deletable: entityType.deletable
                },
                keyProperties: entityType.keys,
                properties: entityType.properties.map(prop => ({
                    name: prop.name,
                    type: prop.type,
                    nullable: prop.nullable,
                    maxLength: prop.maxLength,
                    isKey: entityType.keys.includes(prop.name)
                }))
            };

            let responseText = `📋 Schema for ${entityName} in ${service.title}:\n\n`;
            responseText += JSON.stringify(schema, null, 2);
            responseText += `\n\n🔧 Use 'execute-entity-operation' with this schema information to perform operations.`;

            return {
                content: [{
                    type: "text" as const,
                    text: responseText
                }]
            };

        } catch (error) {
            this.logger.error('Error getting entity schema:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `❌ Error getting schema: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }

    /**
     * Execute CRUD operations on entities with comprehensive error handling
     */
    private async executeEntityOperation(args: Record<string, unknown>) {
        try {
            const serviceId = args.serviceId as string;
            const entityName = args.entityName as string;
            const operation = args.operation as string;
            const parameters = args.parameters as Record<string, unknown> || {};
            const queryOptions = args.queryOptions as Record<string, unknown> || {};
            const useUserToken = args.useUserToken !== false; // Default to true

            // Validate service
            const service = this.discoveredServices.find(s => s.id === serviceId);
            if (!service) {
                // Check if user provided a title instead of an id
                const serviceByTitle = this.discoveredServices.find(s => s.title.toLowerCase() === serviceId.toLowerCase());
                let errorMessage = `❌ Service not found: ${serviceId}\n\n`;
                
                if (serviceByTitle) {
                    errorMessage += `⚠️  It looks like you used the 'title' field instead of the 'id' field!\n`;
                    errorMessage += `✅ Use this serviceId instead: ${serviceByTitle.id}\n\n`;
                    errorMessage += `Remember: Always use the 'id' field from search-sap-services results, NOT the 'title' field.`;
                } else {
                    errorMessage += `💡 Use 'search-sap-services' to find available services.\n`;
                    errorMessage += `⚠️  Make sure you're using the 'id' field from search results, NOT the 'title' field.`;
                }
                
                return {
                    content: [{
                        type: "text" as const,
                        text: errorMessage
                    }],
                    isError: true
                };
            }

            // Validate entity
            const entityType = service.metadata?.entityTypes?.find(e => e.name === entityName);
            if (!entityType) {
                return {
                    content: [{
                        type: "text" as const,
                        text: `❌ Entity '${entityName}' not found in service '${serviceId}'`
                    }],
                    isError: true
                };
            }

            // Set user token if requested and available
            if (useUserToken && this.userToken) {
                this.sapClient.setUserToken(this.userToken);
            } else {
                this.sapClient.setUserToken(undefined);
            }

            // Execute the operation
            let response;
            let operationDescription = "";

            switch (operation) {
                case 'read':
                    operationDescription = `Reading ${entityName} entities`;
                    if (queryOptions.$top) operationDescription += ` (top ${queryOptions.$top})`;
                    if (queryOptions.$filter) operationDescription += ` with filter: ${queryOptions.$filter}`;

                    response = await this.sapClient.readEntitySet(service.url, entityType.entitySet!, queryOptions, false);
                    break;

                case 'read-single': {
                    const keyValue = this.buildKeyValue(entityType, parameters);
                    operationDescription = `Reading single ${entityName} with key: ${keyValue}`;
                    response = await this.sapClient.readEntity(service.url, entityType.entitySet!, keyValue, false);
                    break;
                }

                case 'create':
                    if (!entityType.creatable) {
                        throw new Error(`Entity '${entityName}' does not support create operations`);
                    }
                    operationDescription = `Creating new ${entityName}`;
                    response = await this.sapClient.createEntity(service.url, entityType.entitySet!, parameters);
                    break;

                case 'update':
                    if (!entityType.updatable) {
                        throw new Error(`Entity '${entityName}' does not support update operations`);
                    }
                    {
                        const updateKeyValue = this.buildKeyValue(entityType, parameters);
                        const updateData = { ...parameters };
                        entityType.keys.forEach(key => delete updateData[key]);
                        operationDescription = `Updating ${entityName} with key: ${updateKeyValue}`;
                        response = await this.sapClient.updateEntity(service.url, entityType.entitySet!, updateKeyValue, updateData);
                    }
                    break;

                case 'delete':
                    if (!entityType.deletable) {
                        throw new Error(`Entity '${entityName}' does not support delete operations`);
                    }
                    {
                        const deleteKeyValue = this.buildKeyValue(entityType, parameters);
                        operationDescription = `Deleting ${entityName} with key: ${deleteKeyValue}`;
                        await this.sapClient.deleteEntity(service.url, entityType.entitySet!, deleteKeyValue);
                        response = { data: { message: `Successfully deleted ${entityName} with key: ${deleteKeyValue}`, success: true } };
                    }
                    break;

                default:
                    throw new Error(`Unsupported operation: ${operation}`);
            }

            let responseText = `✅ ${operationDescription}\n\n`;
            responseText += JSON.stringify(response.data, null, 2);

            return {
                content: [{
                    type: "text" as const,
                    text: responseText
                }]
            };

        } catch (error) {
            this.logger.error('Error executing entity operation:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `❌ Error executing ${args.operation} operation on ${args.entityName}: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }

    /**
     * Build key value for entity operations (handles single and composite keys)
     */
    private buildKeyValue(entityType: EntityType, parameters: Record<string, unknown>): string {
        const keyProperties = entityType.properties.filter(p => entityType.keys.includes(p.name));

        if (keyProperties.length === 1) {
            const keyName = keyProperties[0].name;
            if (!(keyName in parameters)) {
                throw new Error(`Missing required key property: ${keyName}. Required keys: ${entityType.keys.join(', ')}`);
            }
            return String(parameters[keyName]);
        }

        // Handle composite keys
        const keyParts = keyProperties.map(prop => {
            if (!(prop.name in parameters)) {
                throw new Error(`Missing required key property: ${prop.name}. Required keys: ${entityType.keys.join(', ')}`);
            }
            return `${prop.name}='${parameters[prop.name]}'`;
        });
        return keyParts.join(',');
    }

    /**
     * Register service metadata resources (unchanged from original)
     */
    public registerServiceMetadataResources(): void {
        this.mcpServer.registerResource(
            "sap-service-metadata",
            new ResourceTemplate("sap://service/{serviceId}/metadata", { list: undefined }),
            {
                title: "SAP Service Metadata",
                description: "Metadata information for SAP OData services"
            },
            async (uri, variables) => {
                const serviceId = typeof variables.serviceId === "string" ? variables.serviceId : "";
                const service = this.discoveredServices.find(s => s.id === serviceId);
                if (!service) {
                    throw new Error(`Service not found: ${serviceId}`);
                }
                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify({
                            service: {
                                id: service.id,
                                title: service.title,
                                description: service.description,
                                url: service.url,
                                version: service.version
                            },
                            entities: service.metadata?.entityTypes?.map(entity => ({
                                name: entity.name,
                                entitySet: entity.entitySet,
                                properties: entity.properties,
                                keys: entity.keys,
                                operations: {
                                    creatable: entity.creatable,
                                    updatable: entity.updatable,
                                    deletable: entity.deletable
                                }
                            })) || []
                        }, null, 2),
                        mimeType: "application/json"
                    }]
                };
            }
        );

        // Register system instructions for Claude AI
        this.mcpServer.registerResource(
            "system-instructions",
            "sap://system/instructions",
            {
                title: "SAP MCP Server Instructions for Claude AI",
                description: "Comprehensive instructions for helping users interact with SAP OData services",
                mimeType: "text/markdown"
            },
            async (uri) => ({
                contents: [{
                    uri: uri.href,
                    text: this.getSystemInstructions(),
                    mimeType: "text/markdown"
                }]
            })
        );

        // Register authentication status resource
        this.mcpServer.registerResource(
            "authentication-status",
            "sap://auth/status",
            {
                title: "Authentication Status and Guidance",
                description: "Current authentication status and user guidance for OAuth flow",
                mimeType: "application/json"
            },
            async (uri) => {
                const authStatus = {
                    authentication: {
                        required: true,
                        configured: true, // XSUAA is configured
                        current_status: this.userToken ? 'authenticated' : 'not_authenticated',
                        token_present: !!this.userToken
                    },
                    user_context: this.userToken ? {
                        has_token: true,
                        message: 'User is authenticated and operations will use their SAP identity',
                        dual_auth_model: {
                            discovery: 'Uses technical user for service metadata discovery',
                            execution: 'Uses your JWT token for all data operations'
                        }
                    } : {
                        has_token: false,
                        message: 'User must authenticate before accessing SAP data',
                        action_required: 'OAuth authentication flow must be completed'
                    },
                    claude_ai_instructions: this.userToken ? {
                        status: 'READY',
                        message: 'User is authenticated. You can now help them access SAP data.',
                        workflow: [
                            'Start with search-sap-services to discover available services',
                            'Use discover-service-entities to explore service capabilities',
                            'Use get-entity-schema to understand entity structure',
                            'Execute CRUD operations with execute-entity-operation'
                        ],
                        security_context: 'Operations execute under authenticated user identity'
                    } : {
                        status: 'AUTHENTICATION_REQUIRED',
                        message: 'CRITICAL: User must authenticate before you can help with SAP operations',
                        required_actions: [
                            'Guide user through OAuth authentication flow',
                            'Explain authentication is mandatory for SAP access',
                            'Provide clear step-by-step authentication instructions',
                            'Do NOT attempt SAP operations without authentication'
                        ],
                        oauth_flow_guidance: {
                            step1: 'Direct user to /oauth/authorize endpoint',
                            step2: 'User logs in with SAP BTP credentials',
                            step3: 'User copies access token from callback',
                            step4: 'User provides token to MCP client',
                            step5: 'Token is included in Authorization header for all requests'
                        }
                    },
                    endpoints: {
                        authorize: '/oauth/authorize',
                        callback: '/oauth/callback',
                        refresh: '/oauth/refresh',
                        userinfo: '/oauth/userinfo',
                        discovery: '/.well-known/oauth-authorization-server'
                    },
                    security_model: {
                        type: 'OAuth 2.0 with SAP XSUAA',
                        token_lifetime: '1 hour',
                        refresh_token_lifetime: '24 hours',
                        scope_based_authorization: true,
                        audit_trail: 'All operations logged under user identity'
                    }
                };

                return {
                    contents: [{
                        uri: uri.href,
                        text: JSON.stringify(authStatus, null, 2),
                        mimeType: "application/json"
                    }]
                };
            }
        );

        this.mcpServer.registerResource(
            "sap-services",
            "sap://services",
            {
                title: "Available SAP Services",
                description: "List of all discovered SAP OData services",
                mimeType: "application/json"
            },
            async (uri) => ({
                contents: [{
                    uri: uri.href,
                    text: JSON.stringify({
                        totalServices: this.discoveredServices.length,
                        categories: Array.from(new Set(Array.from(this.serviceCategories.values()).flat())),
                        services: this.discoveredServices.map(service => ({
                            id: service.id,
                            title: service.title,
                            description: service.description,
                            entityCount: service.metadata?.entityTypes?.length || 0,
                            categories: this.serviceCategories.get(service.id) || []
                        }))
                    }, null, 2)
                }]
            })
        );
    }

    /**
     * Generate comprehensive system instructions for Claude AI
     */
    private getSystemInstructions(): string {
        return `# 🔐 SAP OData MCP Server - AUTHENTICATION REQUIRED

**CRITICAL FOR CLAUDE AI**: This server requires OAuth 2.0 authentication for all SAP operations.

## ⚠️ AUTHENTICATION STATUS CHECK

**BEFORE HELPING USERS**: Always check the authentication-status resource (sap://auth/status) to understand if the user is authenticated.

## 🚨 MANDATORY AUTHENTICATION WORKFLOW

**If user is NOT authenticated:**
1. **STOP** - Do not attempt any SAP operations
2. **GUIDE USER**: Direct them to complete OAuth authentication first
3. **EXPLAIN**: Authentication is mandatory for SAP data access
4. **PROVIDE INSTRUCTIONS**: Step-by-step OAuth flow guidance

**Authentication Requirements:**
1. User must navigate to /oauth/authorize endpoint to get access token
2. User must include token in Authorization header: \`Bearer <token>\`
3. Server uses dual authentication model:
   - **Discovery operations**: Technical user (reliable metadata access)
   - **Data operations**: User's JWT token (proper authorization & audit trail)

## 🛠️ Available Tools

You have access to 4 hierarchical discovery tools:

### 1. search-sap-services
- **Purpose**: Find and filter available SAP OData services
- **Parameters**: query (optional), category (business-partner, sales, finance, etc.), limit
- **Use when**: User wants to explore available services or find specific business areas
- **Example**: "Find all sales-related services" → Use category: "sales"

### 2. discover-service-entities
- **Purpose**: List all entities within a specific service
- **Parameters**: serviceId (required), showCapabilities (boolean)
- **Use when**: User wants to understand what data is available in a service
- **Example**: "What can I do with the customer service?" → Use the service ID from search results

### 3. get-entity-schema
- **Purpose**: Get detailed schema information for an entity
- **Parameters**: serviceId, entityName
- **Use when**: User needs to understand entity structure before CRUD operations
- **Shows**: Properties, types, keys, nullable fields, capabilities

### 4. execute-entity-operation
- **Purpose**: Perform CRUD operations on entities
- **Parameters**: serviceId, entityName, operation, parameters, queryOptions, useUserToken
- **Operations**: read, read-single, create, update, delete
- **Use when**: User wants to interact with actual data

## 📋 Recommended Workflow

### For Data Discovery:
1. Start with \`search-sap-services\` to find relevant services
2. Use \`discover-service-entities\` to explore what's available
3. Use \`get-entity-schema\` for detailed entity information

### For Data Operations:
1. Complete discovery workflow first
2. Use \`execute-entity-operation\` with appropriate parameters
3. Always check entity capabilities before write operations

## 🎯 Best Practices for Helping Users

### Authentication Guidance:
- Always remind users about OAuth requirements
- If operations fail with auth errors, guide them to get a fresh token
- Explain that discovery uses technical user, operations use their credentials

### Query Optimization:
- Use OData query options ($filter, $select, $top) to limit data
- Encourage filtering to avoid large result sets
- Show users how to construct proper OData filters

### Error Handling:
- If entity not found, suggest using discovery tools first
- For permission errors, explain JWT token requirements
- Guide users to check entity capabilities before operations

### Natural Language Processing:
- Translate user requests into appropriate tool calls
- Break complex requests into multiple steps
- Explain what you're doing and why

## 🔍 Common User Scenarios

### "Show me customer data"
1. Search for business-partner or customer services
2. Discover entities in the relevant service
3. Read customer entities with appropriate filters

### "Create a new order"
1. Find sales/order services
2. Get schema for order entity
3. Check if entity is creatable
4. Execute create operation with required fields

### "Update inventory levels"
1. Search for logistics/inventory services
2. Discover material/inventory entities
3. Check update capabilities
4. Execute update with new values

## ⚠️ Important Reminders

- **Always authenticate first**: Guide users through OAuth flow
- **Respect entity capabilities**: Don't attempt creates on read-only entities
- **Use proper OData syntax**: Help construct valid filters and selects
- **Security context**: Operations run under user's SAP credentials
- **Token expiration**: Tokens expire (typically 1 hour) - guide refresh

## 🎭 Your Role

Act as an expert SAP consultant who:
- Understands business processes and data relationships
- Can translate business needs into technical operations
- Provides clear, step-by-step guidance
- Explains SAP concepts in user-friendly terms
- Ensures secure, authorized access to data

Remember: You're not just executing commands, you're helping users understand and work with their SAP data safely and effectively.`;
    }
}