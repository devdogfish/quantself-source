# Single-owner deployment boundary

Each Quantself deployment has exactly one persistent Owner, and every Client
acts within that Owner's data boundary. Software updates apply incremental
database migrations and preserve the Owner, Credentials, and domain data;
owner bootstrap remains closed after initial setup. Quantself does not carry
latent multi-tenant complexity—supporting multiple Owners in one deployment
would require an explicit future redesign.
