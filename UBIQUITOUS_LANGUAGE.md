# Ubiquitous Language

## Access and identity

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Owner** | The person whose Quantself instance and personal data are being managed. | User, account, tenant |
| **Client** | Software that uses the Quantself API with an Owner's authorization, such as an app, agent, script, device, integration, or service. An Owner is a person, never a Client. | Caller, actor, principal, machine |
| **Credential** | Proof that lets Quantself authenticate an Owner or Client. | Login, identity, permission |
| **Owner Session** | A time-limited Credential created after the Owner authenticates interactively. | Cookie, login |
| **API Key** | A revocable bearer Credential that authenticates one Client. | Token, secret, machine credential |
| **Permission Area** | A part of Quantself whose access can be granted independently, such as Inventory, Health, Productivity, or Notes. | Domain, container |
| **Permission** | An allowed action within one Permission Area, such as Inventory Read or Inventory Delete. | Role, privilege, scope |
| **Permission Set** | The complete collection of Permissions granted to one Client. | Role, preset |
| **Access Context** | The Owner, Client, and Permission Set governing one interaction with Quantself. | Actor, identity, session |
| **Authentication** | Validation of a Credential to produce an Access Context. | Login check, identity check |
| **Authorization** | Verification that an Access Context contains the Permission required for an interaction. | Authentication, role check |
| **Quantself API** | The platform-independent application boundary used by every Client. | Backend, web API, integration API |
| **Web Client** | The built-in browser interface that presents Quantself API capabilities without owning application behavior. | Main app, backend, database client |

## Inventory

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Inventory Item** | The shared description of an interchangeable belonging or item group. | Product, SKU, physical copy |
| **Inventory Placement** | A positive quantity of one Inventory Item kept in one Container or left unplaced. | Product, copy, location |
| **Container** | A named physical holder in which Inventory Placements can be kept. | Container label, location, box ID |
| **Capture** | The creation of an Inventory Item from source facts and optional media. | Import, enrichment, upload |
| **Add Units** | An increase to an Inventory Item's quantity in one Inventory Placement. | Capture duplicate, add item |
| **Move Units** | An atomic transfer of quantity between two Inventory Placements. | Relocate item, edit container |
| **Remove Units** | A decrease to an Inventory Item's quantity in one Inventory Placement. | Delete item, archive item |
| **Archived Inventory Item** | An Inventory Item retained for reference but hidden from ordinary inventory surfaces. | Deleted item, disposed item |
| **Archive** | A reversible transition that removes an Inventory Item from ordinary inventory surfaces. | Delete, hide |
| **Restore** | The transition that returns an Archived Inventory Item to ordinary inventory surfaces. | Unhide, recover |
| **Delete** | Permanent removal of an Inventory Item and its attached records and files. | Archive, remove units |
| **Item Media** | An image, audio recording, video, or file attached to an Inventory Item. | Item image, attachment, upload |

## Relationships

- An **Owner** authorizes zero or more **Clients**.
- An **Owner** is a person and never a **Client**.
- A Quantself deployment contains exactly one persistent **Owner**.
- A **Client** acts within exactly one **Owner's** data boundary per request.
- When the **Owner** uses the browser, the **Web Client** is the Client.
- A **Client** presents a Credential; successful **Authentication** produces an
  **Access Context**.
- **Authorization** checks the Access Context's **Permission Set**.
- An **Owner Session**, **API Key**, or future Credential produces the same kind
  of **Access Context**.
- The **Web Client** and every external **Client** use the same **Quantself API**
  contract.
- A **Permission** combines one **Permission Area** and one action.
- An **Inventory Item** has zero or more **Inventory Placements**.
- An **Inventory Placement** belongs to exactly one **Inventory Item** and
  optionally one **Container**.
- Removing the final unit automatically **Archives** the Inventory Item.
- **Archive** and **Restore** require Inventory Write; **Delete** requires
  Inventory Delete.

## Example dialogue

> **Dev:** "The API Key is valid. What can this Client do?"
>
> **Domain expert:** "Read its Permission Set. Inventory Write permits Capture
> and placement changes; Inventory Delete permits permanent deletion."
>
> **Dev:** "Whose Item does the Client change?"
>
> **Domain expert:** "The Owner who authorized that Client. The inventory
> belongs to the Owner."
>
> **Dev:** "What happens when the Client removes the final unit?"
>
> **Domain expert:** "The Item is archived automatically. It disappears from
> ordinary inventory surfaces but can still be restored."

## Legacy language to remove

- **Actor**, **Principal**, **Machine Principal**, **Agent**, and **Caller**
  are not domain terms. Use **Client** for software using the API.
- The current `Actor` structure means **Access Context**; its `Principal` field
  means **Client**.
- **Scope** currently means a machine-readable Permission ID such as
  `inventory:read`, but it is easily confused with project scope. Say
  **Permission** in prose and reserve `scope` for protocol fields.

## Flagged ambiguities

- **Machine Credential** currently means a Client's **API Key** plus management
  metadata. Decide whether the management object should be called Client Access
  or Client Credential.
- "Containerize permissions" may mean compartmentalizing access by
  **Permission Area**. It should not be confused with physical inventory
  **Containers** or software containers.
