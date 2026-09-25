import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.argv.includes("--version")) {
  process.stdout.write("Serena 1.7.0\n");
  process.exit(0);
}

const toolNames = [
  "get_symbols_overview",
  "find_symbol",
  "find_referencing_symbols",
  "find_implementations",
  "find_declaration",
  "get_diagnostics_for_file",
];
if (process.argv.includes("--extra")) {
  toolNames.push("replace_symbol_body");
}

const server = new McpServer({
  name: "fake-serena",
  version: "1.0.0",
});

for (const name of toolNames) {
  server.registerTool(
    name,
    {
      description: `Fake Serena tool ${name}.`,
      inputSchema: {
        relative_path: z.string().optional(),
        name_path: z.string().optional(),
        name_path_pattern: z.string().optional(),
        max_answer_chars: z.number().int().optional(),
      },
    },
    async (input) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ name, input }),
        },
      ],
    }),
  );
}

await server.connect(new StdioServerTransport());
