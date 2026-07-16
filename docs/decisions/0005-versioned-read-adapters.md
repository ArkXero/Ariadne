# ADR 0005: Versioned Read Adapters

Status: accepted

Current configs normalize to v4, task attempts use run record v4, and workflows use batch record v2. Versionless/v1/v2/v3 configs adapt with warnings; historical v1/v2/v3 runs and v1 batches normalize into canonical views without mutation. Unknown future versions and corrupt records remain explicit structured failures so history never silently misinterprets data.
