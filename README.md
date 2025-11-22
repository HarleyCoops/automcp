# AutoMCP CLI

AutoMCP is a lightweight Node.js CLI that:

1. Uses the [`mcp/fetch`](https://hub.docker.com/r/mcp/fetch) MCP server (via Docker) to pull API documentation.
2. Prompts an LLM to design a complete Node/TypeScript MCP server for that API.
3. Creates an isolated [E2B](https://e2b.dev) sandbox, writes all files, and runs `npm install` + `npm run build`.
4. Prints structured JSON with the sandbox ID, build logs, and generated files—perfect for hackathon demos.

No Mastra runtime is required anymore; the repository now contains a single CLI workflow.

---

## Requirements

| Dependency    | Purpose                                      |
| ------------- | -------------------------------------------- |
| Node.js ≥ 20  | Native `fetch`, ESM support                  |
| Docker        | Runs the `mcp/fetch` server                  |
| `E2B_API_KEY` | Authenticates sandbox creation               |
| LLM API key   | `OPENAI_API_KEY` (default) or `GROQ_API_KEY` |

Optional environment variables:

```
# LLM provider selection
LLM_PROVIDER=openai        # or groq
LLM_MODEL=gpt-4o-mini      # optional override

# API keys (provide whichever provider you choose)
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk-...
```

> The CLI automatically starts `docker run -i --rm mcp/fetch` whenever it needs documentation. Make sure Docker Desktop (or daemon) is running.

---

## Setup

```bash
git clone <repo-url>
cd autoMCP
pnpm install

# Provide secrets (use your own secure method)
export E2B_API_KEY=...
export LLM_PROVIDER=openai         # or groq
export OPENAI_API_KEY=...          # required if LLM_PROVIDER=openai
export GROQ_API_KEY=...            # required if LLM_PROVIDER=groq
export LLM_MODEL=...               # optional override
```

Build (emits `dist/`):

```bash
pnpm build
```

Run directly with tsx during development:

```bash
pnpm dev -- \
  --apiName "JSONPlaceholder" \
  --baseUrl https://jsonplaceholder.typicode.com \
  --docs https://jsonplaceholder.typicode.com/
```

Run the compiled CLI:

```bash
pnpm start -- \
  --apiName "JSONPlaceholder" \
  --baseUrl https://jsonplaceholder.typicode.com \
  --docs https://jsonplaceholder.typicode.com/ \
  --maxIterations 3
```

The `--maxIterations` flag controls how many build/validation attempts the agent makes (default 3, min 1, max 10).

---

## Web UI

AutoMCP includes a web-based UI for easy access in your browser.

### Start the Web Server

**Development mode:**

```bash
pnpm dev:web
```

**Production mode (after building):**

```bash
pnpm build
pnpm start:web
```

The web UI will be available at `http://localhost:3000` (or the port specified by `PORT` environment variable).

### Using the Web UI

1. Open your browser and navigate to `http://localhost:3000`
2. Fill in the form:
   - **API Name**: A friendly name for your API (e.g., "JSONPlaceholder")
   - **Base URL**: The base URL of the API (e.g., "https://api.example.com")
   - **Documentation URL**: URL to the API documentation
   - **Max Attempts**: Number of build/validation retries (default 3)
3. Click "Generate MCP Server"
4. Wait for the generation to complete (this may take 1-2 minutes)
5. View the results, including:
   - Generated file locations
   - Build logs
   - Next steps for testing

The web UI provides a user-friendly interface for generating MCP servers without needing to use the command line.

The CLI prints JSON similar to:

```json
{
  "sandboxId": "sbx_XYZ",
  "projectDir": "/home/user/generated/jsonplaceholder-mcp",
  "filesWritten": [
    "/home/user/generated/jsonplaceholder-mcp/package.json",
    "/home/user/generated/jsonplaceholder-mcp/src/server.ts",
    "... more files ..."
  ],
  "localPath": "/abs/path/output/jsonplaceholder",
  "commands": [
    {
      "command": "npm install",
      "exitCode": 0,
      "stdout": "...",
      "stderr": "",
      "durationMs": 5230
    },
    {
      "command": "npm run build",
      "exitCode": 0,
      "stdout": "...",
      "stderr": "",
      "durationMs": 3120
    }
  ],
  "documentationSource": "mcp-fetch",
  "summary": "MCP server exposing endpoints GET /posts, GET /users, POST /posts."
}
```

Artifacts are saved under `output/<slug>/` (e.g., `output/jsonplaceholder`). That folder contains the generated source, `Dockerfile`, and any extra files suggested by the LLM.

---

## How It Works

1. **Docs Fetcher (`src/lib/mcpFetchClient.ts`)**

   - Spawns `docker run -i --rm mcp/fetch` through the MCP SDK.
   - Calls the `fetch` tool to convert any documentation URL into markdown/plain text.
   - Falls back to raw HTTP `fetch` if MCP is unavailable.

2. **LLM Planner (`src/lib/llm.ts`)**

   - Sends the docs, API name, and base URL to your chosen LLM provider (OpenAI by default, Groq optional).
   - The model returns JSON describing endpoints, optional extra files, and shell commands.
   - Ensures `npm install` and `npm run build` are always included.

3. **Sandbox Runner (`src/lib/e2bSandbox.ts`)**

   - Creates an E2B sandbox, writes every file into `/home/user/generated/<api>-mcp`, and runs the commands in order.
   - Captures stdout/stderr plus exit codes for each command.
   - Tears down the sandbox as soon as commands finish.

4. **Template & Local Copy (`src/templates/mcpProject.ts`, `src/lib/localSaver.ts`)**

   - Combines the LLM metadata with a known-good MCP server template (package.json, tsconfig, `src/server.ts`, `Dockerfile`, README).
   - Saves all generated files to `output/<slug>/` so you can inspect or deploy them locally.

5. **CLI (`src/cli.ts`)**
   - Parses `--apiName`, `--baseUrl`, `--docs`.
   - Verifies required environment variables.
   - Calls the orchestrator (`runAutoMcp`) and prints the final JSON result.

---

## Troubleshooting

| Problem                                | Fix                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `docker: command not found`            | Install Docker Desktop/Engine and restart the CLI.                        |
| CLI logs `MCP tools unavailable`       | Docker fetch server failed—check `docker run -i --rm mcp/fetch` manually. |
| `E2B_API_KEY is not set`               | Visit [e2b.dev](https://e2b.dev) to create an API key, then export it.    |
| Build fails due to missing LLM API key | Export `OPENAI_API_KEY` (or `GROQ_API_KEY` if `LLM_PROVIDER=groq`).       |

For verbose MCP debugging, run the fetch server manually:

```bash
docker run -it --rm -p 8080:8080 mcp/fetch
```

Then call it with curl to inspect responses.

---

## Deploying to Fly.io

You can host the web UI + API so teammates can generate/download MCP servers remotely.

### 1. Install Fly tooling

```bash
curl -L https://fly.io/install.sh | sh
fly auth signup    # or fly auth login
```

### 2. Configure the app

This repo now contains a production `Dockerfile` (root) that builds the TypeScript bundle and runs `dist/webServer.js`. Create an app and set secrets:

```bash
fly launch --no-deploy   # answer prompts (keep Dockerfile)

fly secrets set \
  E2B_API_KEY=... \
  LLM_PROVIDER=openai \
  OPENAI_API_KEY=... \
  GROQ_API_KEY=...        # only if LLM_PROVIDER=groq
```

Optional secrets: `LLM_MODEL`, `PORT` (defaults to 3000 inside the container).

### 3. Deploy

```bash
fly deploy
```

Fly will build using the included Dockerfile, expose the Express server, and serve the static UI from `public/`. You can share the Fly-issued URL so others can submit jobs and download their generated MCP projects from the returned JSON (`localPath` is relative inside the container—consider wiring S3, Fly volumes, or a download endpoint if you need persistent artifacts).

---

## Project Structure

```
src/
  cli.ts                 # CLI entry point
  webServer.ts           # Express web server for UI
  autoMcp.ts             # Orchestration logic
  lib/
    mcpFetchClient.ts    # Connects to mcp/fetch
    llm.ts               # OpenAI prompt + JSON parsing
    e2bSandbox.ts        # Writes files and runs commands inside E2B
public/
  index.html             # Web UI frontend
```

This minimal layout makes it easy to swap the LLM provider, MCP server, or sandbox technology if needed.
