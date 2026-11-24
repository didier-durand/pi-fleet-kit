---
name: hello-world
description: Prints a friendly greeting, optionally personalized with a name or language. Use when the user asks for a hello/greeting demo, wants to test that skills load, or says "hello world".
---

# Hello World!

Skill version: 1.0.0 (semver — matches tag skill-hello-world-1.0.0)
Author: Didier Durand
Date: 2026-11-24


Greet the user warmly. Follow these rules:

1. If the user supplied a **name**, greet them by it; otherwise use "World".
2. If the user supplied a **language** (or a name that clearly implies one, e.g.
   "Pierre"), translate the greeting — otherwise default to English.
   Common greetings: French `Bonjour`, Spanish `Hola`, German `Hallo`,
   Japanese `こんにちは`, Portuguese `Olá`.
3. Output exactly one greeting line, in this format:

   ```
   Hello, <name>! (from the hello-world skill 👋)
   ```

4. Then, to prove the skill ran end-to-end, execute the bundled script and
   show its output:

   ```bash
   bash scripts/hello.sh <name or "World">
   ```

   The script also reports the current user (`id -un`/`whoami`) and the
   current session id (from the `PI_SESSION_ID` environment variable),
   which Pi exposes to the processes it runs.

5. Finish by telling the user that if they saw both the greeting and the
   script output, skills are loading correctly.
