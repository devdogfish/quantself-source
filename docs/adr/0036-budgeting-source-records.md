# Budgeting source records

Quantself stores the Budget Note as editable Markdown. Codex reads the note and proposes explicit changes against the current plan revision. The Owner applies a reviewed proposal from Budgeting. The API validates and stores the resulting structured plan so forecasts, receipt capture, and expense entry can work without an open Codex session. An edit to the note invalidates its pending proposal.

Cash Runway is calculated from a cash balance checkpoint, logged expenses, and the plan. A checkpoint for today uses the time it was saved to count subsequent same-day expense entries. Earlier checkpoints use the end of the selected day. Weekly spending still uses the complete logged week. Matching a payment to a bill replaces that occurrence's estimated cost with the actual expense. A monthly match stays tied to the same month if the bill's due day changes.

The Receipt and Expense have separate records. A receipt retains the original image and editable printed details. An expense can exist independently, supports budget allocation, and can match a planned bill. Deleting a receipt removes its linked cash expense and reopens any matched bill. An imported bank transaction survives removal of its receipt. All clients use the Budgeting API.

An archived receipt has no effect on spending until it is explicitly recorded as cash. Posted bank transactions are deduplicated per account. Either bank or receipt import can trigger the same matching calculation. Automatic links require a unique candidate on both sides with compatible merchant, date, and amount. Amount-only candidates remain available for optional linking.
