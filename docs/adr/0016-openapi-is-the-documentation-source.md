# OpenAPI is the documentation source

Quantself's executable OpenAPI 3.1 contract is the sole source for public API
documentation. Scalar renders the interactive human reference from that
contract, while `openapi.json`, generated Markdown, and `llms.txt` serve SDKs,
tools, and Clients; endpoint behavior is not duplicated in separately
maintained prose. Contract validation requires stable operation IDs, scopes,
destructive-operation metadata, examples, side effects, retry safety, and
expected failures so generated references remain useful to both people and
agents. Scalar remains a self-hosted renderer and API client; its hosted Agent
and MCP integration stay disabled so Quantself does not upload its API contract
or delegate Credentials to an external agent service.
