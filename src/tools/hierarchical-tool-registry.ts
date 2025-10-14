import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SAPClient } from "../services/sap-client.js";
import { Logger } from "../utils/logger.js";
import { ODataService, EntityType } from "../types/sap-types.js";
import { z } from "zod";

/**
 * Hierarchical Tool Registry - Solves the "tool explosion" problem
 *
 * Instead of registering hundreds of CRUD tools upfront (5 ops × 40+ entities × services),
 * this registry uses an intelligent discovery approach with just 2 smart tools:
 * 1. discover-sap-data - Universal intelligent search across services, entities, and properties
 *                        with context-aware detail levels (summary for search, full for direct access)
 * 2. execute-sap-operation - Perform CRUD operations on any entity
 *
 * This reduces AI assistant context from 200+ tools to just 2, solving token overflow
 * and dramatically improving tool selection for AI assistants like Claude and Microsoft Copilot.
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
     * Register the 2 intelligent discovery tools instead of 200+ individual CRUD tools
     */
    public async registerDiscoveryTools(): Promise<void> {
        this.logger.info(`🔧 Registering intelligent discovery tools for ${this.discoveredServices.length} services`);

        // Tool 1: Intelligent universal discovery
        this.mcpServer.registerTool(
            "discover-sap-data",
            {
                title: "Discover SAP Data",
                description: "AUTHENTICATION AWARE: Intelligent universal discovery tool for SAP OData services, entities, and properties. Automatically returns the right level of detail based on your query: summary for searches, full schema for direct access. Discovery uses technical user, but data operations require user authentication. This is your single tool for ALL SAP data discovery.",
                inputSchema: {
                    query: z.string().optional().describe("Search term to find services, entities, or properties. Searches across service names, entity names, and property names. Examples: 'customer', 'email', 'sales order'. Returns summary information with match relevance."),
                    category: z.string().optional().describe("Service category filter. Valid values: business-partner, sales, finance, procurement, hr, logistics, all. Default: all. Narrows search results to specific business area."),
                    serviceId: z.string().optional().describe("Direct access to a specific service. When provided without entityName, returns service details with all entities (summary). When provided with entityName, returns full entity schema. IMPORTANT: Use the 'id' field from previous results, NOT the 'title' field."),
                    entityName: z.string().optional().describe("Direct access to a specific entity. Requires serviceId. Returns FULL entity schema with all properties, types, keys, and constraints. IMPORTANT: Use the 'name' field from previous results, NOT the 'entitySet' field."),
                    includeFullSchema: z.boolean().optional().describe("Force full schema in search results. Default: false for searches, true when entityName is provided. Set to true if you need complete property details for all search matches."),
                    limit: z.number().min(1).max(20).optional().describe("Maximum number of results to return when searching. Default: 10")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.discoverDataUnified(args);
            }
        );

        // Tool 2: Execute operations on entities
        this.mcpServer.registerTool(
            "execute-sap-operation",
            {
                title: "Execute SAP Operation",
                description: "AUTHENTICATION REQUIRED: Perform CRUD operations on SAP entities using authenticated user context. This tool requires valid JWT token for authorization and audit trail. Use discover-sap-data first to find and understand available services and entities. Operations execute under user's SAP identity.",
                inputSchema: {
                    serviceId: z.string().describe("The SAP service ID from discover-sap-data. IMPORTANT: Use the 'id' field from the search results, NOT the 'title' field."),
                    entityName: z.string().describe("The entity name from discover-sap-data. IMPORTANT: Use the 'name' field from the results, NOT the 'entitySet' field."),
                    operation: z.string().describe("The operation to perform. Valid values: read, read-single, create, update, delete"),
                    parameters: z.record(z.any()).optional().describe("Operation parameters such as keys, filters, and data. For read-single/update/delete operations, include the entity key properties. For create/update operations, include the entity data fields."),
                    filterString: z.string().optional().describe("OData $filter query option value. Use OData filter syntax without the '$filter=' prefix. Examples: \"Status eq 'Active'\", \"Amount gt 1000\", \"Name eq 'John' and Status eq 'Active'\". Common operators: eq (equals), ne (not equals), gt (greater than), lt (less than), ge (greater/equal), le (less/equal), and, or, not."),
                    selectString: z.string().optional().describe("OData $select query option value. Comma-separated list of property names to include in the response, without the '$select=' prefix. Example: \"Name,Status,CreatedDate\" or \"CustomerID,CustomerName\"."),
                    expandString: z.string().optional().describe("OData $expand query option value. Comma-separated list of navigation properties to expand, without the '$expand=' prefix. Example: \"Customer,Items\" or \"OrderDetails\"."),
                    orderbyString: z.string().optional().describe("OData $orderby query option value. Specify property name and direction (asc/desc), without the '$orderby=' prefix. Examples: \"Name desc\", \"CreatedDate asc\", \"Amount desc, Name asc\"."),
                    topNumber: z.number().optional().describe("OData $top query option value. Number of records to return (limit/page size). This will be converted to the $top parameter. Example: 10 returns top 10 records."),
                    skipNumber: z.number().optional().describe("OData $skip query option value. Number of records to skip (offset for pagination). This will be converted to the $skip parameter. Example: 20 skips first 20 records."),
                    useUserToken: z.boolean().optional().describe("Use the authenticated user's token for this operation. Default: true for data operations")
                }
            },
            async (args: Record<string, unknown>) => {
                return this.executeEntityOperation(args);
            }
        );

        this.logger.info("✅ Registered 2 intelligent discovery tools successfully");
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
     * Intelligent unified discovery method - handles all discovery scenarios with context-aware detail levels
     *
     * Behavior:
     * 1. serviceId + entityName → Full entity schema (direct access)
     * 2. serviceId only → Service + entities summary
     * 3. query + includeFullSchema → Search with full schemas
     * 4. query only → Search with summary (efficient)
     */
    private async discoverDataUnified(args: Record<string, unknown>) {
        const serviceId = args.serviceId as string | undefined;
        const entityName = args.entityName as string | undefined;
        const query = args.query as string | undefined;
        const includeFullSchema = args.includeFullSchema as boolean | undefined;

        // Case 1: Direct entity access → Return FULL schema
        if (serviceId && entityName) {
            return this.getEntitySchema({ serviceId, entityName });
        }

        // Case 2: Service access → Return service + entities summary
        if (serviceId) {
            return this.discoverServiceEntities(args);
        }

        // Case 3 & 4: Search mode
        if (query !== undefined || args.category !== undefined) {
            return this.searchServicesAndEntities(args, includeFullSchema || false);
        }

        // No valid parameters provided
        return {
            content: [{
                type: "text" as const,
                text: `ERROR: Please provide either 'query', 'category', 'serviceId', or 'serviceId + entityName' to discover SAP data.\n\nExamples:\n- Search: { query: "customer" }\n- Service entities: { serviceId: "API_SALES_ORDER_SRV" }\n- Entity schema: { serviceId: "API_SALES_ORDER_SRV", entityName: "SalesOrder" }`
            }],
            isError: true
        };
    }

    /**
     * Intelligent search across services, entities, and properties
     * Returns different detail levels based on includeFullSchema flag
     */
    private async searchServicesAndEntities(args: Record<string, unknown>, includeFullSchema: boolean) {
        try {
            const query = (args.query as string)?.toLowerCase() || "";
            let category = (args.category as string)?.toLowerCase() || "all";
            const limit = (args.limit as number) || 10;

            // Validate category
            const validCategories = ["business-partner", "sales", "finance", "procurement", "hr", "logistics", "all"];
            if (!validCategories.includes(category)) {
                category = "all";
            }

            const matches: any[] = [];

            // Search across all services
            for (const service of this.discoveredServices) {
                // Filter by category first
                if (category !== "all") {
                    const serviceCategories = this.serviceCategories.get(service.id) || [];
                    if (!serviceCategories.includes(category)) {
                        continue;
                    }
                }

                const serviceIdLower = service.id.toLowerCase();
                const serviceTitleLower = service.title.toLowerCase();
                const serviceDescLower = service.description.toLowerCase();

                // Service-level match
                let serviceScore = 0;
                if (query) {
                    if (serviceIdLower.includes(query)) serviceScore = 0.9;
                    else if (serviceTitleLower.includes(query)) serviceScore = 0.85;
                    else if (serviceDescLower.includes(query)) serviceScore = 0.7;
                }

                if (serviceScore > 0 || !query) {
                    matches.push({
                        type: "service",
                        score: serviceScore || 0.5,
                        service: {
                            id: service.id,
                            title: service.title,
                            description: service.description,
                            entityCount: service.metadata?.entityTypes?.length || 0,
                            categories: this.serviceCategories.get(service.id) || []
                        },
                        matchReason: serviceScore > 0 ? `Service matches '${query}'` : `Service in category '${category}'`
                    });
                }

                // Entity-level matches within this service
                if (service.metadata?.entityTypes && query) {
                    for (const entity of service.metadata.entityTypes) {
                        const entityNameLower = entity.name.toLowerCase();
                        let entityScore = 0;

                        // Match entity name
                        if (entityNameLower.includes(query)) {
                            entityScore = 0.95;
                        }

                        // Match property names
                        let matchedProperties: string[] = [];
                        for (const prop of entity.properties) {
                            if (prop.name.toLowerCase().includes(query)) {
                                matchedProperties.push(prop.name);
                                if (entityScore === 0) entityScore = 0.75;
                            }
                        }

                        if (entityScore > 0) {
                            const match: any = {
                                type: entityScore >= 0.9 ? "entity" : "property",
                                score: entityScore,
                                service: {
                                    id: service.id,
                                    title: service.title
                                },
                                entity: {
                                    name: entity.name,
                                    entitySet: entity.entitySet,
                                    keyProperties: entity.keys,
                                    propertyCount: entity.properties.length,
                                    capabilities: {
                                        readable: true,
                                        creatable: entity.creatable,
                                        updatable: entity.updatable,
                                        deletable: entity.deletable
                                    }
                                },
                                matchReason: entityScore >= 0.9
                                    ? `Entity '${entity.name}' matches '${query}'`
                                    : `Properties [${matchedProperties.join(', ')}] match '${query}'`
                            };

                            // Include full schema if requested
                            if (includeFullSchema) {
                                match.entity.properties = entity.properties.map(prop => ({
                                    name: prop.name,
                                    type: prop.type,
                                    nullable: prop.nullable,
                                    maxLength: prop.maxLength,
                                    isKey: entity.keys.includes(prop.name)
                                }));
                            } else {
                                // Just include property names for summary
                                match.entity.propertyNames = entity.properties.map(p => p.name);
                                if (matchedProperties.length > 0) {
                                    match.entity.matchedProperties = matchedProperties;
                                }
                            }

                            matches.push(match);
                        }
                    }
                }
            }

            // Sort by relevance score
            matches.sort((a, b) => b.score - a.score);

            // Apply limit
            const totalFound = matches.length;
            const limitedMatches = matches.slice(0, limit);

            const result = {
                query: query || "all",
                category: category,
                totalFound: totalFound,
                showing: limitedMatches.length,
                detailLevel: includeFullSchema ? "full" : "summary",
                matches: limitedMatches
            };

            let responseText = `Found ${totalFound} matches`;
            if (query) responseText += ` for "${query}"`;
            if (category !== "all") responseText += ` in category "${category}"`;
            responseText += `:\n\n${JSON.stringify(result, null, 2)}`;

            if (limitedMatches.length > 0) {
                responseText += `\n\n== NEXT STEPS ==`;
                responseText += `\n1. To get full entity schema: Call discover-sap-data with serviceId and entityName`;
                responseText += `\n2. To see all entities in a service: Call discover-sap-data with just serviceId`;
                responseText += `\n3. To execute operations: Use execute-sap-operation with serviceId, entityName, and operation`;
                responseText += `\n\nIMPORTANT: Use the 'id' field for serviceId and 'name' field for entityName`;
            } else {
                responseText += `\n\n== SUGGESTION ==`;
                responseText += `\nTry different search terms or categories: business-partner, sales, finance, procurement, hr, logistics, all`;
            }

            return {
                content: [{
                    type: "text" as const,
                    text: responseText
                }]
            };

        } catch (error) {
            this.logger.error('Error searching services and entities:', error);
            return {
                content: [{
                    type: "text" as const,
                    text: `Error searching: ${error instanceof Error ? error.message : String(error)}`
                }],
                isError: true
            };
        }
    }

    /**
     * Legacy search services method (kept for backward compatibility)
     */
    private async searchServices(args: Record<string, unknown>) {
        try {
            const query = (args.query as string)?.toLowerCase() || "";
            let category = (args.category as string)?.toLowerCase() || "all";
            const limit = (args.limit as number) || 10;

            // Validate category for better Copilot compatibility
            const validCategories = ["business-partner", "sales", "finance", "procurement", "hr", "logistics", "all"];
            if (!validCategories.includes(category)) {
                category = "all"; // Default to 'all' if invalid category provided
            }

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
                responseText += `\n\n== NEXT STEPS ==`;
                responseText += `\n1. Call 'discover-sap-data' with serviceId parameter to see entities within a service`;
                responseText += `\n2. Set serviceId to the 'id' field from the results above`;
                responseText += `\n3. IMPORTANT: Use the 'id' field as serviceId, NOT the 'title' field`;
            } else {
                responseText += `\n\n== SUGGESTION ==`;
                responseText += `\nTry different search terms or categories: business-partner, sales, finance, procurement, hr, logistics, all`;
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
                let errorMessage = `ERROR: Service not found: ${serviceId}\n\n`;

                if (serviceByTitle) {
                    errorMessage += `WARNING: It looks like you used the 'title' field instead of the 'id' field!\n`;
                    errorMessage += `CORRECTION: Use this serviceId instead: ${serviceByTitle.id}\n\n`;
                    errorMessage += `Remember: Always use the 'id' field from search-sap-services results, NOT the 'title' field.`;
                } else {
                    errorMessage += `SUGGESTION: Use 'discover-sap-data' to find available services.\n`;
                    errorMessage += `REMINDER: Make sure you're using the 'id' field from search results, NOT the 'title' field.`;
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
                        text: `WARNING: No entities found for service: ${serviceId}. The service metadata may not have loaded properly.`
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

            let responseText = `Service: ${service.title} (${serviceId})\n`;
            responseText += `Found ${entities.length} entities\n\n`;
            responseText += JSON.stringify(serviceInfo, null, 2);
            responseText += `\n\n== NEXT STEPS ==\n`;
            responseText += `1. Call 'discover-sap-data' with serviceId and entityName to get full entity schema\n`;
            responseText += `   - Set entityName to the 'name' field from above (NOT 'entitySet')\n`;
            responseText += `2. Use 'execute-sap-operation' to perform CRUD operations on an entity\n`;
            responseText += `   - Set entityName to the 'name' field from above (NOT 'entitySet')\n`;
            responseText += `\nIMPORTANT: Always use the 'name' field for entityName, never use the 'entitySet' field`;

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
                    text: `ERROR: Failed to discover entities: ${error instanceof Error ? error.message : String(error)}`
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
                let errorMessage = `ERROR: Service not found: ${serviceId}\n\n`;

                if (serviceByTitle) {
                    errorMessage += `WARNING: It looks like you used the 'title' field instead of the 'id' field!\n`;
                    errorMessage += `CORRECTION: Use this serviceId instead: ${serviceByTitle.id}\n\n`;
                    errorMessage += `Remember: Always use the 'id' field from search-sap-services results, NOT the 'title' field.`;
                } else {
                    errorMessage += `SUGGESTION: Use 'discover-sap-data' to find available services.\n`;
                    errorMessage += `REMINDER: Make sure you're using the 'id' field from search results, NOT the 'title' field.`;
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
                        text: `ERROR: Entity '${entityName}' not found in service '${serviceId}'\n\nAvailable entities: ${availableEntities}`
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

            let responseText = `Schema for ${entityName} in ${service.title}:\n\n`;
            responseText += JSON.stringify(schema, null, 2);
            responseText += `\n\n== NEXT STEPS ==`;
            responseText += `\n1. Use 'execute-sap-operation' tool to perform operations on this entity`;
            responseText += `\n2. Refer to the keyProperties above when performing read-single, update, or delete operations`;
            responseText += `\n3. Check the capabilities section to see which operations are allowed`;
            responseText += `\n4. Use the properties list to understand what fields can be set for create/update operations`;

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
                    text: `ERROR: Failed to get schema: ${error instanceof Error ? error.message : String(error)}`
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
            let operation = (args.operation as string)?.toLowerCase();
            const parameters = args.parameters as Record<string, unknown> || {};

            // Validate operation for better Copilot compatibility
            const validOperations = ["read", "read-single", "create", "update", "delete"];
            if (!validOperations.includes(operation)) {
                throw new Error(`Invalid operation: ${operation}. Valid operations are: ${validOperations.join(', ')}`);
            }

            // Build queryOptions from flattened parameters for better Copilot compatibility
            const queryOptions: Record<string, unknown> = {};
            if (args.filterString) queryOptions.$filter = args.filterString;
            if (args.selectString) queryOptions.$select = args.selectString;
            if (args.expandString) queryOptions.$expand = args.expandString;
            if (args.orderbyString) queryOptions.$orderby = args.orderbyString;
            if (args.topNumber) queryOptions.$top = args.topNumber;
            if (args.skipNumber) queryOptions.$skip = args.skipNumber;

            // Also support legacy queryOptions object for backward compatibility
            if (args.queryOptions && typeof args.queryOptions === 'object') {
                Object.assign(queryOptions, args.queryOptions);
            }

            const useUserToken = args.useUserToken !== false; // Default to true

            // Validate service
            const service = this.discoveredServices.find(s => s.id === serviceId);
            if (!service) {
                // Check if user provided a title instead of an id
                const serviceByTitle = this.discoveredServices.find(s => s.title.toLowerCase() === serviceId.toLowerCase());
                let errorMessage = `ERROR: Service not found: ${serviceId}\n\n`;

                if (serviceByTitle) {
                    errorMessage += `WARNING: It looks like you used the 'title' field instead of the 'id' field!\n`;
                    errorMessage += `CORRECTION: Use this serviceId instead: ${serviceByTitle.id}\n\n`;
                    errorMessage += `Remember: Always use the 'id' field from search-sap-services results, NOT the 'title' field.`;
                } else {
                    errorMessage += `SUGGESTION: Use 'discover-sap-data' to find available services.\n`;
                    errorMessage += `REMINDER: Make sure you're using the 'id' field from search results, NOT the 'title' field.`;
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
                        text: `ERROR: Entity '${entityName}' not found in service '${serviceId}'`
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

            let responseText = `SUCCESS: ${operationDescription}\n\n`;
            responseText += `== RESULT ==\n`;
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
                    text: `ERROR: Failed to execute ${args.operation} operation on ${args.entityName}: ${error instanceof Error ? error.message : String(error)}`
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
                            'Use discover-sap-data to search for services, entities, or properties',
                            'Call discover-sap-data with serviceId + entityName for full schema when needed',
                            'Execute CRUD operations with execute-sap-operation'
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
     * Generate comprehensive system instructions for AI assistants
     */
    private getSystemInstructions(): string {
        return `# SAP OData MCP Server - AUTHENTICATION REQUIRED

CRITICAL FOR AI ASSISTANTS: This server requires OAuth 2.0 authentication for all SAP operations.

== AUTHENTICATION STATUS CHECK ==

BEFORE HELPING USERS: Always check the authentication-status resource (sap://auth/status) to understand if the user is authenticated.

== MANDATORY AUTHENTICATION WORKFLOW ==

If user is NOT authenticated:
1. STOP - Do not attempt any SAP operations
2. GUIDE USER - Direct them to complete OAuth authentication first
3. EXPLAIN - Authentication is mandatory for SAP data access
4. PROVIDE INSTRUCTIONS - Step-by-step OAuth flow guidance

Authentication Requirements:
1. User must navigate to /oauth/authorize endpoint to get access token
2. User must include token in Authorization header: \`Bearer <token>\`
3. Server uses dual authentication model:
   - Discovery operations: Technical user (reliable metadata access)
   - Data operations: User's JWT token (proper authorization and audit trail)

== AVAILABLE TOOLS ==

You have access to 2 intelligent tools:

1. discover-sap-data (INTELLIGENT UNIVERSAL DISCOVERY)
- Purpose: Single tool for ALL discovery - services, entities, AND properties
- Intelligence: Automatically returns the right detail level
  - Search mode (query) → Summary with relevance scores
  - Direct access (serviceId + entityName) → Full schema
  - Service view (serviceId only) → Entities summary
- Parameters:
  - query: Search across services, entities, properties
  - category: Filter by business area
  - serviceId: Direct service access
  - entityName: Direct entity access (full schema)
  - includeFullSchema: Force full detail in searches
- Examples:
  - "Find customer email" → Searches everything
  - { serviceId: "X", entityName: "Y" } → Full schema
  - { query: "sales" } → Summary with scores
- This ONE tool handles ALL discovery needs

2. execute-sap-operation
- Purpose: Perform CRUD operations on entities
- Parameters: serviceId, entityName, operation, parameters, OData options
- Operations: read, read-single, create, update, delete
- Use when: User wants to interact with actual data
- All data operations happen here

== RECOMMENDED WORKFLOW ==

Simple Workflow (Most Common):
1. discover-sap-data with query → Find what you need
2. discover-sap-data with serviceId + entityName → Get full schema
3. execute-sap-operation → Perform operation

Quick Workflow (Know What You Want):
1. discover-sap-data with serviceId + entityName → Get full schema in one call
2. execute-sap-operation → Perform operation

Search Workflow (Exploratory):
1. discover-sap-data with query → See all matches with scores
2. Refine with serviceId for entity list OR serviceId + entityName for schema
3. execute-sap-operation → Perform operation

== BEST PRACTICES ==

Authentication Guidance:
- Always remind users about OAuth requirements
- If operations fail with auth errors, guide them to get a fresh token
- Explain that discovery uses technical user, operations use their credentials

Query Optimization:
- Use OData query options (filterString, selectString, topNumber) to limit data
- Encourage filtering to avoid large result sets
- Show users how to construct proper OData filters

Error Handling:
- If entity not found, suggest using discovery tools first
- For permission errors, explain JWT token requirements
- Guide users to check entity capabilities before operations

Natural Language Processing:
- Translate user requests into appropriate tool calls
- Break complex requests into multiple steps
- Explain what you're doing and why

== COMMON USER SCENARIOS ==

"Show me customer data"
1. discover-sap-data with query: "customer"
2. See matches for Customer entity with relevance scores
3. execute-sap-operation to read with filters

"I need to update a customer's email"
1. discover-sap-data with query: "customer email"
→ Finds entities with both customer and email properties
2. discover-sap-data with serviceId + entityName for full schema
3. execute-sap-operation with operation: "update"

"Create a new sales order"
1. discover-sap-data with query: "sales order"
2. discover-sap-data with serviceId + entityName for required fields
3. Check capabilities (creatable: true)
4. execute-sap-operation with operation: "create"

"Find all entities with 'Status' property"
1. discover-sap-data with query: "status"
→ Returns all entities across all services with Status property
2. Pick relevant entity
3. execute-sap-operation as needed

== IMPORTANT REMINDERS ==

- Always authenticate first: Guide users through OAuth flow
- Respect entity capabilities: Don't attempt creates on read-only entities
- Use proper OData syntax: Help construct valid filters and selects
- Security context: Operations run under user's SAP credentials
- Token expiration: Tokens expire (typically 1 hour) - guide refresh

== YOUR ROLE ==

Act as an expert SAP consultant who:
- Understands business processes and data relationships
- Can translate business needs into technical operations
- Provides clear, step-by-step guidance
- Explains SAP concepts in user-friendly terms
- Ensures secure, authorized access to data

Remember: You're not just executing commands, you're helping users understand and work with their SAP data safely and effectively.`;
    }
}