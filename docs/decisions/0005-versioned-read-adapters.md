# ADR 0005: Versioned Read Adapters

Status: accepted

New configs and manifests are v2. Versionless/v1 configs normalize to v2 with warnings, and historical v1 runs normalize into the canonical view without mutation. Unknown future versions and corrupt records remain explicit structured failures so history never silently misinterprets data.
