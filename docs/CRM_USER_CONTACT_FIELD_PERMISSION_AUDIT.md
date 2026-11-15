# CRM User Contact-Field Permission Audit

Date: 2026-11-15. Feature: an Administrator-controlled, per-user permission to edit Lead/Contact **phone numbers and email addresses**. Test status words: PASSED / FAILED / SKIPPED / BLOCKED / NOT RUN.

## 1. Previous state

No such permission existed. Any signed-in user who could open a contact (or the lead it belongs to) could add, change, delete or re-prioritise its phone numbers and emails through the contact server actions; the only check was record access (`assertContactAccess`). Additionally, `updateContactField` wrote whatever object it was given straight to the `Contact` row (it was only *typed* as the three name fields) - a **mass-assignment hole**: a direct call could set `primaryEmail`, `primaryPhone`, `ownerId` or `companyId`.

## 2. Existing permission model (inspected before choosing a design)

`Account` has a role enum and two explicit-grant arrays, `paymentPermissions` and `bookingPermissions` (default-deny, validated against fixed lists, step-up on granting, audited). Both are payment/booking specific, and the arrays are deliberately independent of each other, so reusing `bookingPermissions` for a contact-data switch would have been semantically wrong. There was no existing flag that could carry this.

## 3. Design and the one migration (genuinely necessary)

A per-user persisted flag needs a column. **Migration `20261115000100_account_contact_detail_edit_permission`** (additive, one statement):

```sql
ALTER TABLE "Account" ADD COLUMN "canEditContactDetails" BOOLEAN NOT NULL DEFAULT true;
```

- **Default `true` and why:** every user can already edit these fields today. `DEFAULT true` therefore preserves exactly each existing user's current ability - **nobody gains access, nobody silently loses it** - and an Administrator can now switch it off per user. (A default of `false` would have silently removed a working capability from every non-admin on deploy.) If the owner prefers default-deny, change `DEFAULT true` to `false` in that migration (or run one `UPDATE`) **before it is ever applied**; no code change is needed, because the server fails closed on a missing flag.
- Existing rows are filled by the same statement; no column, index or row is changed or dropped; it is not applied anywhere by this task (**no migration was run against any database**). `prisma validate` and `prisma generate` pass; the file has no byte-order mark; it is listed in `src/lib/migration-manifest.json` (the schema-status check).
- Administrators are **never** restricted by the flag (in code: `canEditContactDetails` is true for `ADMIN`).

## 4. Server-side enforcement

`canEditContactDetails(account)` (`src/lib/permissions.ts`): Admin -> true; otherwise only when the account object carries `canEditContactDetails === true` (**fails closed** if the field is missing).

Every path that writes a contact's phone or email goes through one new guard, `assertContactDetailEditAccess` (`src/server/actions/contacts.ts`), which checks the permission **first** and then the existing record access. Covered actions (all eight): `updatePrimaryPhoneNumber`, `updatePrimaryEmailAddress`, `addContactPhone`, `addContactEmail`, `setPrimaryPhone`, `setPrimaryEmail`, `deleteContactPhone`, `deleteContactEmail`. These are the only mutation paths for those fields: lead pages call the same actions (with `leadId`); `updateLeadField` has no phone/email field (its schema is closed); bulk import and lead creation only **create** new contacts and were not changed (creating a record is not editing an existing one).

**Mass-assignment fixed:** `updateContactField` now writes only `firstName`, `middleName` and `lastName` (blank first/last name or a non-string is rejected), so it can no longer be used to change phone, email, owner or company. Names remain editable by everyone who could edit them before.

Refusal message (thrown, as the surrounding actions do; the UI hides the controls so a normal user never triggers it): "You do not have permission to edit phone numbers or email addresses". Unrelated edits (names, notes, lead fields, status, reassignment) are untouched.

## 5. Admin control

- **Users page**: new column **"Can Edit Lead/Contact Phone & Email"** with a switch per user (Administrators show "Always").
- **Action `updateContactDetailEditPermission(accountId, enabled)`** (`src/server/actions/accounts.ts`): Administrator only; same-company targets only ("not found" otherwise); **an Administrator target is refused** with an explanatory message (no self-lockout, and no way to lock another Admin out of managing contact data); turning it **on** needs the same recent-sign-in step-up as the other grants (returned message, audited refusal), turning it **off** never does; writes exactly one column; audits `CONTACT_DETAIL_EDIT_PERMISSION_CHANGED` with the role and from/to only (no contact data); a no-op request writes nothing.
- It persists in the database, so it survives sessions and restarts. The account row is re-read on every request (`getCurrentAccount` loads the full account), so a change takes effect on the user's **next request**.

## 6. UI behaviour when not allowed

Lead and Contact detail pages pass the decision to `CustomerInfoCard`: the primary phone/email become read-only text, and the phone/email lists lose the add, make-primary and delete buttons; names stay editable; a short note says to ask an Administrator. The server remains the authority.

## 7. Test status

| Suite | Result |
| --- | --- |
| `contact-detail-edit-permission.test.ts` (14): every one of the 8 actions refused with the permission off for each non-admin role, refused without the flag, refused unauthenticated, allowed with it on, always allowed for Admin; names still editable; mass-assignment stripped; blank/non-string rejected; nothing is written when refused | PASSED |
| `contact-detail-edit-permission-admin.test.ts` (13): Admin can switch off/on, step-up for turning on, no step-up for off, every other role refused, other-company target not found, Admin target refused, no-op writes nothing, malformed input, audit row has no contact data | PASSED |
| `customer-info-card.test.tsx` (+2): controls present when allowed, absent when not, names editable | PASSED |
| `permissions.test.ts` | PASSED |
| Against a real PostgreSQL (column default, existing rows, persistence across restart) | NOT RUN - no database; the migration was **not** applied anywhere |
| Browser check of the Users page toggle | NOT RUN (no database to sign in) |

## 8. Decisions left to the owner

1. Default `true` (preserve today) versus default-deny - see section 3.
2. Whether Managers (who can reach team contacts) should be treated like any other non-admin for this switch (they are).
