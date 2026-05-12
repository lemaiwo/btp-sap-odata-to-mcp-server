# Deployment Guide

## Prerequisites

1. SAP BTP Global Account with CloudFoundry environment
2. Cloud Foundry CLI installed and configured
3. MBT (Multi-Target Application Archive Builder) installed
4. Access to on-premise SAP system
5. SAP Cloud Connector configured (for on-premise connectivity)

## Step-by-Step Deployment

### 1. Prepare BTP Environment

```bash
# Login to Cloud Foundry
cf login -a https://api.cf.{region}.hana.ondemand.com

# Target your org and space
cf target -o your-org -s your-space
```

### 2. Configure Destinations in BTP

You must create **two destinations** in SAP BTP: one for service discovery (technical user) and one for execution (principal propagation / SSO).

#### Destination 1 — Discovery (Technical User)

Used to list available OData services. Configured via `SAP_DISCOVERY_DESTINATION_NAME` (default: `SAP_SYSTEM_TECH_SBX`).

- **Name:** `SAP_SYSTEM_TECH_SBX`
- **Type:** HTTP
- **Authentication:** BasicAuthentication
- **Proxy Type:** OnPremise
- **User:** [technical_sap_user]
- **Password:** [technical_sap_password]
- **URL:** https://[virtual-hostname]:[port] (as configured in SAP Cloud Connector)

#### Destination 2 — Execution (Principal Propagation / SSO)

Used to execute OData calls on behalf of the connected user. Configured via `SAP_EXECUTION_DESTINATION_NAME` (default: `SAP_SYSTEM_SSO_SBX`).

- **Name:** `SAP_SYSTEM_SSO_SBX`
- **Type:** HTTP
- **Authentication:** PrincipalPropagation
- **Proxy Type:** OnPremise
- **URL:** https://[virtual-hostname]:[port] (as configured in SAP Cloud Connector)

> **Note:** Principal Propagation requires SAP Cloud Connector to be configured with trust between BTP and the on-premise system. If you prefer Basic Authentication with a different user, use `BasicAuthentication` with the appropriate credentials.

#### Environment Variables (set in `mta.yaml` properties)

```yaml
SAP_DISCOVERY_DESTINATION_NAME: SAP_SYSTEM_TECH_SBX
SAP_EXECUTION_DESTINATION_NAME: SAP_SYSTEM_SSO_SBX
```

For more details on creating destinations, see the [SAP BTP documentation](https://help.sap.com/docs/btp/sap-business-technology-platform/creating-destinations).

### 3. Build the Application

Use the following npm script to build the application and generate the MTAR archive:

```bash
npm run build:btp
```

This will compile the project and create the MTAR file in the `mta_archives` directory.

### 4. Deploy the Application

Use the following npm script to deploy the MTAR archive to SAP BTP:

```bash
npm run deploy:btp
```

This will upload and deploy the application to your Cloud Foundry space.