import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import { SAPClient } from './sap-client.js';
import { Logger } from '../utils/logger.js';
import { Config } from '../utils/config.js';
import { ODataService, EntityType, ServiceMetadata, FunctionImport, FunctionParameter } from '../types/sap-types.js';

import { JSDOM } from 'jsdom';

export class SAPDiscoveryService {
    private catalogEndpoints = [
        '/sap/opu/odata4/iwfnd/config/default/iwfnd/catalog/0002/ServiceGroups?$expand=DefaultSystem($expand=Services)',
        '/sap/opu/odata/sap/$metadata'
    ];

    constructor(
        private sapClient: SAPClient,
        private logger: Logger,
        private config: Config
    ) { }

    async discoverAllServices(): Promise<ODataService[]> {
        const services: ODataService[] = [];

        try {
            // Log current filtering configuration
            const filterConfig = this.config.getServiceFilterConfig();
            this.logger.info('OData service discovery configuration:', filterConfig);

            // Try OData V4 catalog first
            const v4Services = await this.discoverV4Services();
            services.push(...v4Services);

            // Also discover V2 services
            const v2Services = await this.discoverV2Services();
            services.push(...v2Services);

                
            // Apply service filtering based on configuration
            const filteredServices = this.filterServices(services);
            this.logger.info(`Discovered ${services.length} total services, ${filteredServices.length} match the filter criteria`);

            // Apply maximum service limit
            const maxServices = this.config.getMaxServices();
            const limitedServices = filteredServices.slice(0, maxServices);

            if (filteredServices.length > maxServices) {
                this.logger.warn(`Service discovery limited to ${maxServices} services (configured maximum). ${filteredServices.length - maxServices} services were excluded.`);
            }

            // Enrich services with metadata
            for (const service of limitedServices) {
                try {
                    this.logger.debug(`Discovering metadata for service: ${service.id} at ${service.metadataUrl}`);
                    service.metadata = await this.getServiceMetadata(service);
                } catch (error) {
                    this.logger.warn(`Failed to get metadata for service ${service.id}:`, error);
                }
            }

            this.logger.info(`Successfully initialized ${limitedServices.length} OData services`);
            return limitedServices;

        } catch (error) {
            this.logger.error('Service discovery failed:', error);
            throw error;
        }
    }

    /**
     * Filter services based on configuration patterns
     */
    private filterServices(services: ODataService[]): ODataService[] {
        const allowAll = this.config.get('odata.allowAllServices', false);

        if (allowAll) {
            this.logger.info('All services allowed - no filtering applied');
            return services;
        }

        const filteredServices = services.filter(service => {
            const isAllowed = this.config.isServiceAllowed(service.id);
            if (isAllowed) {
                this.logger.debug(`Service included: ${service.id}`);
            }
            return isAllowed;
        });

        return filteredServices;
    }

    private async discoverV4Services(): Promise<ODataService[]> {
        try {
            const destination = await this.sapClient.getDestination();

            const response = await executeHttpRequest(destination, {
                method: 'GET',
                url: this.catalogEndpoints[0],
                headers: {
                    'Accept': 'application/json'
                }
            });

            return this.parseV4CatalogResponse(response.data);

        } catch (error) {
            this.logger.warn('V4 service discovery failed:', error);
            return [];
        }
    }

    private async discoverV2Services(): Promise<ODataService[]> {
        try {
            const destination = await this.sapClient.getDestination();

            const response = await executeHttpRequest(destination, {
                method: 'GET',
                url: '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection?$top=1000',
                headers: {
                    'Accept': 'application/json'
                }
            });

            return this.parseV2CatalogResponse(response.data);

        } catch (error) {
            this.logger.error('V2 service discovery failed:', error);
            return [];
        }
    }

    private parseV4CatalogResponse(catalogData: unknown): ODataService[] {
        interface Service {
            ServiceId: string;
            ServiceVersion?: string;
            Title?: string;
            Description?: string;
        }
        interface ServiceGroup {
            DefaultSystem?: { Services?: Service[] };
        }
        const services: ODataService[] = [];
        const value = (catalogData as { value?: ServiceGroup[] }).value;
        if (value) {
            value.forEach((serviceGroup) => {
                if (serviceGroup.DefaultSystem?.Services) {
                    serviceGroup.DefaultSystem.Services.forEach((service) => {
                        services.push({
                            id: service.ServiceId,
                            version: service.ServiceVersion || '0001',
                            title: service.Title || service.ServiceId,
                            description: service.Description || `OData service ${service.ServiceId}`,
                            odataVersion: 'v4',
                            url: `/sap/opu/odata4/sap/${service.ServiceId.toLowerCase()}/srvd/sap/${service.ServiceId.toLowerCase()}/${service.ServiceVersion || '0001'}/`,
                            metadataUrl: `/sap/opu/odata4/sap/${service.ServiceId.toLowerCase()}/srvd/sap/${service.ServiceId.toLowerCase()}/${service.ServiceVersion || '0001'}/$metadata`,
                            entitySets: [],
                            metadata: null
                        });
                    });
                }
            });
        }
        return services;
    }

    private parseV2CatalogResponse(catalogData: unknown): ODataService[] {
        interface V2Service {
            ID: string;
            TechnicalServiceVersion?: string;
            Title?: string;
            Description?: string;
            ServiceUrl: string;
            TechnicalServiceName: string;
        }
        const services: ODataService[] = [];
        const results = (catalogData as { d?: { results?: V2Service[] } }).d?.results;
        if (results) {
            results.forEach((service) => {
                const baseURL = `/sap/opu/odata/${service.ServiceUrl.split("/sap/opu/odata/")[1]}${service.TechnicalServiceName.includes("TASKPROCESSING") && Number(service.TechnicalServiceVersion)>1?`;mo`:``}/`;
                services.push({
                    id: service.ID,
                    version: service.TechnicalServiceVersion || '0001',
                    title: service.Title || service.ID,
                    description: service.Description || `OData service ${service.ID}`,
                    odataVersion: 'v2',
                    url: baseURL,
                    metadataUrl: `${baseURL}$metadata`,
                    entitySets: [],
                    metadata: null
                });
            });
        }
        return services;
    }

    private async getServiceMetadata(service: ODataService): Promise<ServiceMetadata> {
        try {
            const destination = await this.sapClient.getDestination();

            const response = await executeHttpRequest(destination, {
                method: 'GET',
                url: service.metadataUrl,
                headers: {
                    'Accept': 'application/xml'
                }
            });
            return this.parseMetadata(response.data, service.odataVersion);

        } catch (error) {
            this.logger.error(`Failed to get metadata for service ${service.id}:`, error);
            throw error;
        }
    }

    private detectODataVersion(metadataXml: string): 'v2' | 'v4' {
        // OData v4 metadata uses Version="4.0" on the Edmx root element
        if (metadataXml.includes('Version="4.0"') || metadataXml.includes("Version='4.0'")) {
            return 'v4';
        }
        return 'v2';
    }

    private parseMetadata(metadataXml: string, hintVersion: string): ServiceMetadata {
        const detectedVersion = this.detectODataVersion(metadataXml);
        // Trust the detected version from the actual XML over the catalog hint
        const odataVersion = detectedVersion;

        const dom = new JSDOM(metadataXml, { contentType: 'text/xml' });
        const xmlDoc = dom.window.document;

        if (odataVersion === 'v4') {
            return this.parseMetadataV4(xmlDoc);
        }
        return this.parseMetadataV2(xmlDoc);
    }

    private parseMetadataV2(xmlDoc: Document): ServiceMetadata {
        const entitySets = this.extractEntitySets(xmlDoc);
        const associations = this.extractAssociations(xmlDoc);
        const entityTypes = this.extractEntityTypes(xmlDoc, entitySets, associations);
        const functionImports = this.extractFunctionImports(xmlDoc);

        return {
            entityTypes,
            entitySets,
            functionImports,
            version: 'v2',
            namespace: this.extractNamespace(xmlDoc)
        };
    }

    /**
     * Build a map of OData Association definitions used to resolve NavigationProperty targets.
     * Key: fully-qualified association name (e.g. "ZAPI_PURCHASEREQ_PROCESS.toItem_PurchaseRequisition")
     * Value: array of End definitions [{type, multiplicity, role}]
     */
    private extractAssociations(xmlDoc: Document): Map<string, Array<{ type: string; multiplicity: string; role: string }>> {
        const map = new Map<string, Array<{ type: string; multiplicity: string; role: string }>>();
        const namespace = this.extractNamespace(xmlDoc);

        xmlDoc.querySelectorAll("Association").forEach((assocNode: Element) => {
            const name = assocNode.getAttribute("Name");
            if (!name) return;

            const ends: Array<{ type: string; multiplicity: string; role: string }> = [];
            assocNode.querySelectorAll("End").forEach((endNode: Element) => {
                ends.push({
                    type: endNode.getAttribute("Type") || '',
                    multiplicity: endNode.getAttribute("Multiplicity") || '*',
                    role: endNode.getAttribute("Role") || ''
                });
            });

            // Store under both qualified and unqualified names for easy lookup
            map.set(`${namespace}.${name}`, ends);
            map.set(name, ends);
        });

        return map;
    }

    private parseMetadataV4(xmlDoc: Document): ServiceMetadata {
        const entityTypes = this.extractEntityTypesV4(xmlDoc);
        const functionImports = this.extractFunctionImportsV4(xmlDoc);

        return {
            entityTypes,
            entitySets: [],   // v4 uses EntityContainer/EntitySet — represented via entityTypes
            functionImports,
            version: 'v4',
            namespace: this.extractNamespace(xmlDoc)
        };
    }

    private extractEntityTypesV4(xmlDoc: Document): EntityType[] {
        const entityTypes: EntityType[] = [];

        // Build EntitySet map from EntityContainer
        const entitySetMap = new Map<string, { name: string; insertable: boolean; updatable: boolean; deletable: boolean }>();
        xmlDoc.querySelectorAll('EntityContainer EntitySet').forEach((node: Element) => {
            const setName = node.getAttribute('Name') || '';
            const entityTypeFQN = node.getAttribute('EntityType') || '';
            // Resolve short name from fully qualified name (e.g. "Namespace.Customer" → "Customer")
            const shortName = entityTypeFQN.includes('.') ? entityTypeFQN.split('.').pop()! : entityTypeFQN;

            // v4 capabilities via Annotations (Org.OData.Capabilities.V1)
            let insertable = true;
            let updatable = true;
            let deletable = true;

            node.querySelectorAll('Annotation').forEach((ann: Element) => {
                const term = ann.getAttribute('Term') || '';
                const boolVal = ann.getAttribute('Bool');
                const record = ann.querySelector('Record PropertyValue[Property="Insertable"], Record PropertyValue[Property="Updatable"], Record PropertyValue[Property="Deletable"]');

                if (term.includes('InsertRestrictions')) {
                    const pv = ann.querySelector('Record PropertyValue[Property="Insertable"]');
                    if (pv) insertable = pv.getAttribute('Bool') !== 'false';
                    else if (boolVal) insertable = boolVal !== 'false';
                }
                if (term.includes('UpdateRestrictions')) {
                    const pv = ann.querySelector('Record PropertyValue[Property="Updatable"]');
                    if (pv) updatable = pv.getAttribute('Bool') !== 'false';
                    else if (boolVal) updatable = boolVal !== 'false';
                }
                if (term.includes('DeleteRestrictions')) {
                    const pv = ann.querySelector('Record PropertyValue[Property="Deletable"]');
                    if (pv) deletable = pv.getAttribute('Bool') !== 'false';
                    else if (boolVal) deletable = boolVal !== 'false';
                }
            });

            entitySetMap.set(shortName, { name: setName, insertable, updatable, deletable });
        });

        xmlDoc.querySelectorAll('EntityType').forEach((node: Element) => {
            const typeName = node.getAttribute('Name') || '';
            const setInfo = entitySetMap.get(typeName);

            const entityType: EntityType = {
                name: typeName,
                namespace: node.parentElement?.getAttribute('Namespace') || '',
                entitySet: setInfo?.name ?? typeName + 'Set',
                creatable: setInfo?.insertable ?? true,
                updatable: setInfo?.updatable ?? true,
                deletable: setInfo?.deletable ?? true,
                addressable: true,
                properties: [],
                navigationProperties: [],
                keys: []
            };

            // Extract properties (v4 has same Property element structure)
            node.querySelectorAll('Property').forEach((propNode: Element) => {
                entityType.properties.push({
                    name: propNode.getAttribute('Name') || '',
                    type: propNode.getAttribute('Type') || '',
                    nullable: propNode.getAttribute('Nullable') !== 'false',
                    maxLength: propNode.getAttribute('MaxLength') ?? undefined
                });
            });

            // Extract keys
            node.querySelectorAll('Key PropertyRef').forEach((keyNode: Element) => {
                entityType.keys.push(keyNode.getAttribute('Name') || '');
            });

            entityTypes.push(entityType);
        });

        return entityTypes;
    }

    private extractFunctionImportsV4(xmlDoc: Document): FunctionImport[] {
        const functionImports: FunctionImport[] = [];

        // v4: Actions (POST) and Functions (GET) inside Schema
        xmlDoc.querySelectorAll('Action, Function').forEach((node: Element) => {
            const name = node.getAttribute('Name');
            if (!name) return;
            const isAction = node.tagName === 'Action' || node.nodeName === 'Action';
            const httpMethod: 'GET' | 'POST' = isAction ? 'POST' : 'GET';
            const returnTypeNode = node.querySelector('ReturnType');
            const returnType = returnTypeNode?.getAttribute('Type') || undefined;

            const parameters: FunctionParameter[] = [];
            node.querySelectorAll('Parameter').forEach((paramNode: Element) => {
                const paramName = paramNode.getAttribute('Name');
                if (!paramName || paramName === 'bindingParameter') return; // skip binding param
                parameters.push({
                    name: paramName,
                    type: paramNode.getAttribute('Type') || 'Edm.String',
                    mode: 'In',
                    nullable: paramNode.getAttribute('Nullable') !== 'false'
                });
            });

            functionImports.push({ name, httpMethod, returnType, parameters });
        });

        return functionImports;
    }

    private extractFunctionImports(xmlDoc: Document): FunctionImport[] {
        const functionImports: FunctionImport[] = [];
        const nodes = xmlDoc.querySelectorAll('FunctionImport');

        nodes.forEach((node: Element) => {
            const name = node.getAttribute('Name');
            if (!name) return;

            // m:HttpMethod attribute — try prefixed and un-prefixed forms
            const httpMethodRaw =
                node.getAttribute('m:HttpMethod') ||
                node.getAttributeNS('http://schemas.microsoft.com/ado/2007/08/dataservices/metadata', 'HttpMethod') ||
                'GET';
            const httpMethod: 'GET' | 'POST' =
                httpMethodRaw.toUpperCase() === 'POST' ? 'POST' : 'GET';

            const returnType = node.getAttribute('ReturnType') || undefined;

            const parameters: FunctionParameter[] = [];
            node.querySelectorAll('Parameter').forEach((paramNode: Element) => {
                const paramName = paramNode.getAttribute('Name');
                if (!paramName) return;
                const modeRaw = paramNode.getAttribute('Mode') || 'In';
                const mode: 'In' | 'Out' | 'InOut' =
                    modeRaw === 'Out' ? 'Out' : modeRaw === 'InOut' ? 'InOut' : 'In';
                parameters.push({
                    name: paramName,
                    type: paramNode.getAttribute('Type') || 'Edm.String',
                    mode,
                    nullable: paramNode.getAttribute('Nullable') !== 'false'
                });
            });

            functionImports.push({ name, httpMethod, returnType, parameters });
        });

        return functionImports;
    }

    private extractEntityTypes(
        xmlDoc: Document,
        entitySets: Array<{ [key: string]: string | boolean | null }>,
        associations: Map<string, Array<{ type: string; multiplicity: string; role: string }>>
    ): EntityType[] {
        const entityTypes: EntityType[] = [];
        const nodes = xmlDoc.querySelectorAll("EntityType");

    nodes.forEach((node: Element) => {
            const entitySet = entitySets.find(entitySet=>(entitySet.entitytype as string)?.split(".")[1] === node.getAttribute("Name"));
            const entityType: EntityType =      {
                name: node.getAttribute("Name") || '',
                namespace: node.parentElement?.getAttribute("Namespace") || '',
                entitySet:entitySet?.name as string,
                creatable: !!entitySet?.creatable,
                updatable: !!entitySet?.updatable,
                deletable: !!entitySet?.deletable,
                addressable: !!entitySet?.addressable,
                properties: [],
                navigationProperties: [],
                keys: []
            };

            // Extract properties
            const propNodes = node.querySelectorAll("Property");
            propNodes.forEach((propNode: Element) => {
                entityType.properties.push({
                    name: propNode.getAttribute("Name") || '',
                    type: propNode.getAttribute("Type") || '',
                    nullable: propNode.getAttribute("Nullable") !== "false",
                    maxLength: propNode.getAttribute("MaxLength") ?? undefined
                });
            });

            // Extract keys
            const keyNodes = node.querySelectorAll("Key PropertyRef");
            keyNodes.forEach((keyNode: Element) => {
                entityType.keys.push(keyNode.getAttribute("Name") || '');
            });

            // Extract navigation properties using the association map
            const navNodes = node.querySelectorAll("NavigationProperty");
            navNodes.forEach((navNode: Element) => {
                const navName = navNode.getAttribute("Name") || '';
                const relationship = navNode.getAttribute("Relationship") || '';
                const toRole = navNode.getAttribute("ToRole") || '';

                // Resolve target entity type and multiplicity via the association definition
                const assocEnds = associations.get(relationship);
                const targetEnd = assocEnds?.find(e => e.role === toRole);
                const targetTypeFull = targetEnd?.type || '';
                // Strip namespace prefix: "NAMESPACE.EntityTypeName" → "EntityTypeName"
                const targetType = targetTypeFull.includes('.') ? targetTypeFull.split('.').pop()! : targetTypeFull;
                const rawMult = targetEnd?.multiplicity || '*';
                const multiplicity: '1' | '0..1' | '*' =
                    rawMult === '1' ? '1' : rawMult === '0..1' ? '0..1' : '*';

                if (navName) {
                    entityType.navigationProperties.push({ name: navName, type: targetType, multiplicity });
                }
            });

            entityTypes.push(entityType);
        });

        return entityTypes;
    }

    private extractEntitySets(xmlDoc: Document): Array<{ [key: string]: string | boolean | null }> {
        const entitySets: Array< { [key: string]: string | boolean | null }> = [];
        const nodes = xmlDoc.querySelectorAll("EntitySet");

    nodes.forEach((node: Element) => {
            const entityset: { [key: string]: string | boolean | null } = {};
            // getAttribute is case-sensitive in XML mode — use exact attribute names from EDMX
            entityset['name'] = node.getAttribute('Name');
            entityset['entitytype'] = node.getAttribute('EntityType');
            ['sap:creatable', 'sap:updatable', 'sap:deletable', 'sap:pageable', 'sap:addressable', 'sap:content-version'].forEach(attr => {
                const [namespace, name ] = attr.split(":");
                entityset[name||namespace] = node.getAttribute(attr);
            });
            ['sap:creatable', 'sap:updatable', 'sap:deletable', 'sap:pageable', 'sap:addressable'].forEach(attr => {
                const [namespace, name ] = attr.split(":");
                entityset[name||namespace] = node.getAttribute(attr) === "false" ? false : true;
            });
            if (entityset.name) {
                entitySets.push(entityset);
            }
        });

        return entitySets;
    }

    private extractNamespace(xmlDoc: Document): string {
        const schemaNode = xmlDoc.querySelector("Schema");
        return schemaNode?.getAttribute("Namespace") || '';
    }
}
