# Start with the resolved legacy Compose model so named volumes keep their exact
# current names. Each slot gets its own network and independent app/API aliases.
def localhost_port($target; $published):
  [{
    mode: "ingress",
    host_ip: "127.0.0.1",
    target: $target,
    published: ($published | tostring),
    protocol: "tcp"
  }];

if ([.services.app.environment, .services.api.environment] |
    all((.QUANTSELF_PUBLIC_ORIGIN | rtrimstr("/")) == $origin and
        (.QUANTSELF_OWNER_INGRESS_TOKEN | test("^[0-9a-f]{64}$"))))
   and (.services.api.environment |
     [.QUANTSELF_WEBSITE_ANALYTICS_INGEST_TOKEN, .QUANTSELF_TRACKED_LINKS_READ_TOKEN,
      .QUANTSELF_TRACKED_LINKS_APPLICATION_TOKEN, .QUANTSELF_TRACKED_LINKS_SHARE_TOKEN] |
      all(type == "string" and test("^[!-~]{32,}$")) and (unique | length) == length)
then . else error("Keep ingress or registry credential configuration is invalid") end
| .name = $project
| .services |= with_entries(select(
    .key == "app" or .key == "api" or .key == "gateway" or .key == "migrate"
    or .key == "inventory-codex-enrichment-worker" or .key == "inventory-preprocessing-worker"
    or .key == "jobs-codex-worker"
  ))
| .services |= with_entries(
    .value |= (del(.container_name, .build, .depends_on) | .pull_policy = "never")
    | if .key != "gateway" then .value.image = $image else . end)
| .services.api.environment.QUANTSELF_API_MODE = "serve"
| .services.api.ports = localhost_port(3001; ($port + 1))
| .services.gateway.ports = localhost_port(3000; $port)
| .services["api-workers"] = (.services.api
    | del(.ports, .expose, .healthcheck)
    | .environment.QUANTSELF_API_MODE = "workers")
| .networks = {quantself_internal: {external: true, name: $network}}
| ([.services[].volumes[]? | select(.type == "volume") | .source] | unique) as $used_volumes
| .volumes |= with_entries(select(.key as $key | $used_volumes | index($key)) | .value |= {external: true, name})
