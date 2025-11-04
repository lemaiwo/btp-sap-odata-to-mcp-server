# 3-Level Progressive Discovery Architecture

## Overview

The SAP OData MCP Server uses a **3-level progressive discovery architecture** optimized for LLM token efficiency and clear workflow separation. This approach solves the "tool explosion" problem by reducing 200+ individual CRUD tools down to just **3 intelligent tools**.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         AI Assistant / LLM                       │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
         ┌────────────────────────────────────────────────┐
         │         3-Level Progressive Discovery          │
         └────────────────────────────────────────────────┘
                  │                 │                 │
        ┌─────────▼─────────┐  ┌───▼──────┐  ┌──────▼──────┐
        │   Level 1         │  │ Level 2  │  │  Level 3    │
        │   Discovery       │  │ Metadata │  │  Execution  │
        │                   │  │          │  │             │
        │ Minimal data      │  │ Full     │  │ Authenticated│
        │ for decision      │  │ schema   │  │ CRUD ops    │
        └───────────────────┘  └──────────┘  └─────────────┘
                  │                 │                 │
                  └─────────────────┴─────────────────┘
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │      SAP OData API       │
                    └──────────────────────────┘
```

## Level 1: discover-sap-data

### Purpose
Lightweight search and discovery of SAP services and entities with **minimal token usage**.

### Returns
Only essential fields for LLM decision-making:
- `serviceId` - Service identifier
- `serviceName` - Human-readable service name
- `entityName` - Entity name within the service
- `entityCount` - Number of entities in the service
- `categories` - Business area categories

### Behavior
1. **With Query**: Returns services/entities matching the search term
2. **No Matches**: Automatically returns ALL available services (still minimal fields)
3. **No Query**: Returns complete service catalog (minimal fields)

### Examples

```javascript
// Search for customer-related entities
{
  "query": "customer",
  "category": "business-partner",
  "limit": 20
}
```

**Response (minimal)**:
```json
{
  "matches": [
    {
      "type": "service",
      "service": {
        "serviceId": "API_BUSINESS_PARTNER",
        "serviceName": "Business Partner API",
        "entityCount": 15,
        "categories": ["business-partner"]
      },
      "entities": [
        { "entityName": "Customer" },
        { "entityName": "Supplier" },
        { "entityName": "BusinessPartner" }
      ]
    }
  ]
}
```

### Token Efficiency
- Returns ~90% less data than full schemas
- Typical response: 1-2KB vs 50-100KB with full schemas
- Allows LLM to quickly scan and select relevant entities

---

## Level 2: get-entity-metadata

### Purpose
Get **complete schema details** for a specific entity after selection from Level 1.

### Returns
Full entity schema including:
- All properties with names and types
- Key properties (primary keys)
- Nullable flags
- Max length constraints
- Capabilities (creatable, updatable, deletable)
- Entity relationships

### Input
```javascript
{
  "serviceId": "API_BUSINESS_PARTNER",  // From Level 1
  "entityName": "Customer"              // From Level 1
}
```

### Output
```json
{
  "service": {
    "serviceId": "API_BUSINESS_PARTNER",
    "serviceName": "Business Partner API",
    "description": "Manage business partners",
    "odataVersion": "2.0"
  },
  "entity": {
    "name": "Customer",
    "entitySet": "CustomerSet",
    "namespace": "API_BUSINESS_PARTNER",
    "keyProperties": ["CustomerID"],
    "propertyCount": 45
  },
  "capabilities": {
    "readable": true,
    "creatable": true,
    "updatable": true,
    "deletable": false
  },
  "properties": [
    {
      "name": "CustomerID",
      "type": "Edm.String",
      "nullable": false,
      "maxLength": 10,
      "isKey": true
    },
    {
      "name": "CustomerName",
      "type": "Edm.String",
      "nullable": true,
      "maxLength": 80,
      "isKey": false
    },
    // ... all other properties
  ]
}
```

### Use Cases
- Understanding entity structure before CRUD operations
- Validating field requirements
- Checking operation capabilities
- Building proper OData queries

---

## Level 3: execute-sap-operation

### Purpose
Execute **authenticated CRUD operations** on SAP entities using metadata from Level 2.

### Operations
- `read` - Query multiple entities
- `read-single` - Get single entity by key
- `create` - Create new entity
- `update` - Update existing entity
- `delete` - Delete entity

### Authentication
**Required**: User JWT token for audit trail and authorization

### Input
```javascript
{
  "serviceId": "API_BUSINESS_PARTNER",
  "entityName": "Customer",
  "operation": "read",
  "filterString": "CustomerName eq 'ACME'",
  "selectString": "CustomerID,CustomerName,Country",
  "topNumber": 10
}
```

### OData Options
- `filterString` - OData $filter (without prefix)
- `selectString` - OData $select (without prefix)
- `expandString` - OData $expand (without prefix)
- `orderbyString` - OData $orderby (without prefix)
- `topNumber` - OData $top limit
- `skipNumber` - OData $skip offset
- `parameters` - Entity data for create/update/delete

---

## Complete Workflow Example

### Scenario: "Update customer ACME's email address"

#### Step 1: Discovery (Level 1)
```javascript
// LLM calls discover-sap-data
{
  "query": "customer"
}
```

**Response**: Minimal list showing Customer entity exists in API_BUSINESS_PARTNER

#### Step 2: Get Schema (Level 2)
```javascript
// LLM calls get-entity-metadata
{
  "serviceId": "API_BUSINESS_PARTNER",
  "entityName": "Customer"
}
```

**Response**: Full schema showing:
- Key: CustomerID
- Email property exists: `EmailAddress` (Edm.String, max 241)
- Updatable: true

#### Step 3: Execute Update (Level 3)
```javascript
// LLM calls execute-sap-operation
{
  "serviceId": "API_BUSINESS_PARTNER",
  "entityName": "Customer",
  "operation": "update",
  "parameters": {
    "CustomerID": "ACME001",
    "EmailAddress": "new@acme.com"
  }
}
```

**Result**: Customer updated successfully

---

## Benefits Over 2-Tool Approach

### Previous (2-Level)
```
discover-sap-data (returns FULL schemas)
        ↓
execute-sap-operation
```

**Problem**: Level 1 returned 50-100KB of schema data, overwhelming LLM context

### Current (3-Level)
```
discover-sap-data (returns MINIMAL data)
        ↓
get-entity-metadata (on-demand full schema)
        ↓
execute-sap-operation
```

**Benefits**:
- ✅ **90% less data** in initial discovery
- ✅ **Progressive detail** - fetch schemas only when needed
- ✅ **Clear separation** - Discovery → Understanding → Execution
- ✅ **Better LLM experience** - smaller responses, clearer workflow
- ✅ **Token efficient** - fits more in context window

---

## Token Usage Comparison

### Scenario: Discovering customer entities

#### 2-Tool Approach
```
discover-sap-data → 50KB response (full schemas)
execute-sap-operation → Operation
```
**Total tokens**: ~15,000 tokens

#### 3-Tool Approach
```
discover-sap-data → 2KB response (minimal)
get-entity-metadata → 5KB response (one entity)
execute-sap-operation → Operation
```
**Total tokens**: ~2,000 tokens

**Savings**: ~87% reduction in tokens

---

## LLM Instructions

### Recommended Workflow

```
ALWAYS follow this 3-step workflow:

1. Call discover-sap-data to find relevant entities
   → Returns minimal list for quick scanning

2. Call get-entity-metadata for selected entity
   → Returns full schema needed for operations

3. Call execute-sap-operation with proper parameters
   → Uses schema from step 2 to execute

⚠️ NEVER skip Level 2!
```

### Common Mistakes to Avoid

❌ **Skipping Level 2**
```
discover-sap-data → execute-sap-operation
(Missing schema details!)
```

❌ **Calling Level 1 multiple times**
```
discover-sap-data → discover-sap-data → discover-sap-data
(Use results from first call!)
```

✅ **Correct Flow**
```
discover-sap-data → get-entity-metadata → execute-sap-operation
```

---

## Known Limitations & Workarounds

### $select Support Issues

⚠️ **Issue**: Not all SAP OData APIs fully support the `$select` query option.

**Symptoms**:
- Errors mentioning "select", "projection", "invalid property", "property not found"
- API returns 400 or 500 errors when using selectString parameter
- Some properties appear as "not found" even though they exist in metadata

**Automatic Detection**:
The error handler automatically detects potential $select-related errors and provides intelligent retry instructions.

**Example Error Response**:
```
⚠️ DETECTED: This error might be related to $select not being fully supported by this SAP API.

🔄 RETRY STRATEGY:
Many SAP OData APIs have incomplete $select support. Please retry the SAME operation with these changes:

1. Remove the selectString parameter (or set it to empty string)
2. Keep all other parameters the same:
   - serviceId: "API_BUSINESS_PARTNER"
   - entityName: "Customer"
   - operation: "read"
   - filterString: "CustomerName eq 'ACME'"
3. DO NOT include selectString parameter

This will return ALL properties instead of a subset, which works with all SAP APIs.
```

**Best Practice**:
- Always be prepared to retry without `selectString` if the first attempt fails
- The error response contains exact parameters to use for retry
- Use `filterString` and `topNumber` to limit data instead of `selectString`

**Supported Alternative**:
- ✅ `filterString` - Widely supported, use to filter rows
- ✅ `topNumber` - Widely supported, use to limit result count
- ✅ `orderbyString` - Generally supported for sorting
- ⚠️ `selectString` - Limited support, use with caution
- ⚠️ `expandString` - Limited support, check API documentation

---

## API Design Principles

### 1. Progressive Disclosure
Provide information in layers, starting with minimal data

### 2. Token Optimization
Return only what's needed at each stage

### 3. Clear Separation of Concerns
- Discovery: "What exists?"
- Metadata: "What are the details?"
- Execution: "Do the operation"

### 4. Fallback Mechanism
If no matches found, return everything (still minimal)

### 5. Single Responsibility
Each level has one clear purpose

---

## Performance Characteristics

### Level 1 (discover-sap-data)
- **Speed**: Very Fast (~50ms)
- **Size**: 1-5KB
- **Cache**: Cached service list
- **Auth**: Technical user (no token needed)

### Level 2 (get-entity-metadata)
- **Speed**: Fast (~100ms)
- **Size**: 5-20KB per entity
- **Cache**: Cached metadata
- **Auth**: Technical user (no token needed)

### Level 3 (execute-sap-operation)
- **Speed**: Varies (SAP response time)
- **Size**: Depends on data
- **Cache**: No caching
- **Auth**: User JWT required

---

## Migration from 2-Tool Approach

If migrating from the previous 2-tool approach:

### Before
```javascript
// Old: discover-sap-data returned everything
discover-sap-data({ query: "customer" })
// → Full schemas returned

execute-sap-operation({ ... })
```

### After
```javascript
// New: discover-sap-data returns minimal
discover-sap-data({ query: "customer" })
// → Minimal list returned

// New: Get schema separately
get-entity-metadata({
  serviceId: "...",
  entityName: "Customer"
})
// → Full schema returned

execute-sap-operation({ ... })
```

---

## Conclusion

The 3-level progressive discovery architecture provides:
- **Optimal token efficiency** for LLM interactions
- **Clear workflow separation** for better UX
- **Progressive detail** for smarter data loading
- **Better scalability** as service counts grow

This architecture is particularly beneficial for:
- Microsoft Copilot (strict token limits)
- Claude (better context management)
- GPT-4 (reduced API costs)
- Any LLM-based integration

---

## See Also

- [MICROSOFT_COPILOT_COMPATIBILITY.md](./MICROSOFT_COPILOT_COMPATIBILITY.md) - Copilot-specific optimizations
- [hierarchical-tool-registry.ts](../src/tools/hierarchical-tool-registry.ts) - Implementation
- [README.md](../README.md) - Project overview
