# Area-action permissions

Client access is compartmentalized with stable `<area>:<action>` Permissions,
such as `inventory:read`, `inventory:write`, and `inventory:delete`, rather than
endpoint-specific scopes. New Quantself areas add their own Permissions without
changing the authentication model. Resources subordinate to an area, including
Inventory Product Media, inherit that area's Permissions and are authorized
through their parent resource; permanent deletion remains independently
grantable from ordinary writes.
