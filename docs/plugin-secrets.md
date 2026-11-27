# Plugin secrets

A Plugin Manifest API 3 plugin can declare a `secret` field in its settings or in
an instance kind. The Server stores the value with envelope encryption. This
document is the contract for that storage. The decision record is
[ADR: Plugin Model V3](adr/plugin-model-v3.md), section 6.

A host connection record also owns secrets: the OAuth client secret, the
access token, the refresh token, and the PKCE verifier of an attempt in
progress. See [Plugin connections](plugin-connections.md#token-storage).

This record does not cover other secrets:

- The Presentation Network key keeps its own contract. See
  [Presentation Networks](presentation-networks.md).
- TOTP secrets and the notification signing secret are not moved.

## Keys

| Key                  | Size     | Where it is                                        |
| -------------------- | -------- | -------------------------------------------------- |
| KEK (key encryption) | 256 bits | The key file `TILECAST_SECRETS_KEY_FILE`           |
| DEK (data encryption)| 256 bits | PostgreSQL, wrapped with one KEK (`plugin_secret_deks`) |

Each KEK has a stable ID, `kek-<uuid>`. The ID is not secret.

### Key file

`TILECAST_SECRETS_KEY_FILE` names the key file. The default is
`/data/secrets/kek.json`, in the data directory and outside the media, update,
package, and backup roots. The Server refuses to start when the path is inside
one of those roots, because a backup or a download would then carry the key.

At first start the Server creates the file with a cryptographic random source and
mode `0600`. These rules apply to the file:

- The file is a regular file that only its owner can read. The Server refuses a
  file that other accounts can read.
- The Server never replaces a file that exists but is not valid. A replacement
  would make every stored secret unreadable. The Server stops and names the cause.
  No message holds key bytes.
- A change replaces the file atomically through a temporary file in the same
  directory. A crash leaves the old file or the new file.
- The file holds the current KEK and every older KEK that a stored DEK still needs.

The file is a versioned JSON document:
`{ "format": "tilecast-secret-keys", "version": 1, "current": "<id>", "keys": [...] }`.
An operator can supply the file as a container secret.

### Where the file lives in a container

The image creates `/data/secrets` with mode `0700`. The default places the key in
the same volume as the media. That volume is not a Tilecast backup, but a
file-level copy of the whole volume contains the key. To prevent that, mount the
key file from a separate secret or volume and set `TILECAST_SECRETS_KEY_FILE`.

## Secret envelope

A secret is encrypted with AES-256-GCM, the current DEK, and a fresh random 96-bit
nonce from the system CSPRNG. The stored bytes are:

```text
version (1 byte, value 1) | nonce (12 bytes) | ciphertext and tag
```

The additional authenticated data binds the secret to its place. It holds these
fields. Each field has a two-byte length before it, so two different lists never
produce the same bytes.

1. `tilecast-secret-v1`
2. the plugin ID
3. the owner type: `organization`, `instance`, `screen`, or `connection`
4. the owner ID: the organization ID, the instance ID, the screen ID, or the
   connection record ID
5. the setting key

A ciphertext that is copied to another plugin, owner, or setting key fails
authentication. A wrapped DEK uses the label `tilecast-dek-v1` with its own ID and
the KEK ID. A wrapped DEK that is moved to another row fails.

Every error is one of two forms: the secret is unavailable, or it needs a new
value. No error holds key bytes, ciphertext, plaintext, or crypto detail.

## Reading

- Studio writes a secret and reads only `set`, `not_set`, or `needs_value`.
  `needs_value` means that a value is stored but this Server cannot decrypt it.
- Plugin code reads a value with `secrets.read@1` in a `studio`, `background`, or
  `system` context. See [Plugin Manifest API 3](plugin-api-v3.md#service-client).
- A secret that is not set, or that cannot be decrypted, answers the stable
  failure `secret_unavailable`. Other secrets and settings keep working.
- A secret never enters a Player manifest, Player state, a log, an audit event, a
  URL, or an error message. An audit event names the keys that changed.
- The Server does not return a secret through the settings or instance API, and it
  does not export one in a configuration export.
- Plugin code never reads a `connection` secret. `secrets.read@1` names only
  `organization`, `instance`, and `screen` owners. The host reads a connection
  secret itself to authenticate to an OAuth provider and to add a bearer
  header to `http.fetch@1`. Deleting the connection record deletes its
  secrets.

## Commands

The commands run on the Server host and read the same `TILECAST_*` variables as
the Server. They print key IDs, never key bytes. The Server keeps running during
`rotate-kek` and `rotate-dek`.

| Command                                      | Effect                                                                  |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `tilecast-server secrets status`             | Shows the key IDs, the export confirmation, and the secret counts.      |
| `tilecast-server secrets rotate-kek`         | Adds a new current KEK and wraps each DEK with it again.                |
| `tilecast-server secrets rotate-dek [--migrate-now]` | Makes a new current DEK for new writes. Moves old secrets in the background. |
| `tilecast-server secrets export-kek <file>`  | Writes every KEK to a new file for offline storage.                     |
| `tilecast-server secrets import-kek <file>`  | Adds the keys of an export that this installation does not hold.        |
| `tilecast-server secrets prune-keks`         | Removes the KEKs that no DEK uses.                                      |

### KEK rotation

1. The command adds a new KEK and writes the file first.
2. The command wraps each DEK that is not under the current KEK with the current
   KEK. Each DEK changes in its own compare-and-swap.
3. The secrets do not change. A KEK rotation does not decrypt or rewrite a secret.

A crash leaves every DEK wrapped with a KEK that the file still holds. Run the
command again to finish. A second run with nothing to do changes nothing. Old
KEKs stay in the file until `prune-keks` removes the ones that no DEK uses. A
Server that runs during the rotation reads the file again before it makes a new
DEK, so no DEK is wrapped with a KEK that the next prune removes. Rotation,
import, and pruning take turns through a lock beside the key file. The Server
reads the current file when it checks restore readiness or export confirmation.

After a KEK rotation, export the keys again. Studio warns Owners until an Owner
confirms an export of the current key set.

### DEK rotation

`rotate-dek` makes a new current DEK. New writes use it at once. A Server task
moves the older secrets to it in bounded batches, one short transaction for each
secret. The task starts with the Server and runs every ten minutes, so it
survives a restart. It can stop at any point:

- Each secret is on its old DEK or on the new DEK. Both stay readable.
- A DEK that no secret uses is retired.
- A secret that this Server cannot decrypt is left in place.

### Export

`export-kek` writes the same format as the key file. It refuses to overwrite a
file. It refuses a path inside the backup root, the media root, the update root,
or the package root. It never writes the file into a Tilecast backup. Store the
file apart from backups.

## Studio warning

Studio shows an account that holds `system.backups` a warning on the generated
plugin pages. The warning shows when the installation stores a
secret and no Owner confirmed an export of the current key set. The confirmation
is `POST /api/v1/system/plugin-secrets/export-confirmations`. It stores the key
IDs of the exported set, not a flag. After a KEK rotation the set differs, so the
warning returns. An installation with no stored secret sees no warning.

The same status shows how many secrets this Server cannot read.

## Backup and restore

A backup from `tilecast-server backup create`, or from Studio, holds the encrypted
secrets and the wrapped DEKs. It never holds a KEK. The manifest records:

- `pluginSecrets.requiredKekIds`: the KEK IDs that the archive needs.
- `pluginSecrets.locations`: for each plugin, owner type, setting key, and KEK, how
  many secrets exist. It holds no value.

Before a restore changes anything, the check compares the required KEK IDs with
the keys on the restoring Server:

- `tilecast-server restore verify <file>` and the Studio restore plan show the
  missing key IDs and each plugin setting that would become unreadable.
- `tilecast-server restore apply <file>` refuses when keys are missing. Pass
  `--confirm-unreadable-secrets` to continue. Studio shows the affected settings
  in the confirmation and sends `confirmUnreadableSecrets`.
- A restore through the API without that confirmation answers `409` with
  `restore_unreadable_secrets` and changes nothing.

To keep the secrets readable, import the exported keys first:

```sh
tilecast-server secrets import-kek /secure/location/keys.json
```

After a confirmed restore without the keys:

- The Server starts. Plugins and settings that hold no lost secret keep working.
- Studio shows each lost secret as `needs a new value`. An operator enters it
  again.
- A plugin that reads a lost secret receives `secret_unavailable`.
- The Server makes a new DEK under its own key when the first new secret is
  written.

A restore keeps personal data until the backup expires. The plugin documentation
must say this for a plugin that stores personal data.

## Threat model

| Threat                                              | Control                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Someone reads a database dump or a Tilecast backup  | Secrets are ciphertext. The KEK is not in the database or in a backup.                   |
| Someone copies a ciphertext to another setting      | The additional authenticated data binds the plugin, the owner, and the key.              |
| An operator reads a secret through the API          | Studio and the API return only the state. `secrets.read@1` is for plugin code.           |
| A secret leaks through a log, an audit event, or a URL | No path writes a value there. Tests search the audit data and the database.           |
| A secret reaches a Player                           | A projection holds only the configuration document, which never holds a secret.           |
| Nonce reuse                                         | A fresh nonce from the system CSPRNG for every encryption.                               |
| A lost key                                          | The export, the restore check, and the `needs a new value` state.                        |

This design does not protect against a person who has both the key file and the
database, or against code that runs in the Server process. A bundled plugin is
first-party code in that process.
