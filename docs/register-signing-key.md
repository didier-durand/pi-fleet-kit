# Register the agent signing key on GitHub

One-time setup so commits signed with `~/.ssh/pi-agent-signing` show the
**Verified** badge.

## Steps

1. Open the public key on your Mac and copy it:

   ```bash
   cat ~/.ssh/pi-agent-signing.pub
   ```

   It is one long line starting with `ssh-ed25519` and ending with the key
   comment. Copy the ENTIRE line (single line, no line breaks).

2. In a browser, go to:
   **https://github.com/settings/keys**
   (GitHub → click your avatar → **Settings** → **SSH and GPG keys**)

3. Click **New SSH key** (top-right).

4. Fill in the form — the "Key type" choice is the part that matters most:

   | Field | Value |
   |---|---|
   | **Title** | `pi-agent signing key` (anything you'll recognize) |
   | **Key type** | **Signing Key** ⚠️ (default is Authentication Key — must change!) |
   | **Key** | paste the copied `ssh-ed25519 ...` line |

5. Click **Add SSH key**. GitHub asks for your password / passkey — confirm.

6. Verify it's listed under **SSH signing keys** (not "SSH keys") on
   https://github.com/settings/keys — same key appears in both sections only
   if you registered it twice with different types.

## Why the Key type matters

- **Authentication Key** = the key can log into servers / authenticate to
  GitHub. Cannot make commits Verified.
- **Signing Key** = the key makes commits Verified. Cannot log into anything.
- The same public key can be registered as both types if ever needed, but for
  this setup choose **Signing Key** only — it matches the principle that the
  agent's key must be signing-only.

## Test that it works

After rebuilding the image and relaunching the agents (see README), the
quickest test is any commit made in the container:

```bash
docker compose -f ~/pi-configs/compose.yml run --rm pi-coding bash -c \
  'cd /workspace && git commit --allow-empty -m "test: signing from container" 2>&1 | tail -2'
```

Then check the commit on GitHub: the repo's commit list should show
**Verified** next to it. Alternatively run `./resign-commits.sh` to re-sign
the existing backlog (see its header comments for usage).

## Revoke anytime

Delete the key from https://github.com/settings/keys → all commits signed
with it instantly lose their Verified badge. No container-side change needed
(though the agent will keep signing; new signatures won't verify until the
key is re-registered).
