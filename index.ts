#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { runAppleScript } from "run-applescript";
import { run } from "@jxa/run";
import { exec } from "child_process";
import { fileURLToPath } from "url";

// Define the ChatGPT tool
const CHATGPT_TOOL: Tool = {
	name: "chatgpt",
	description: "Interact with the ChatGPT desktop app on macOS",
	inputSchema: {
		type: "object",
		properties: {
			operation: {
				type: "string",
				description: "Operation to perform: 'ask' or 'get_conversations'",
				enum: ["ask", "get_conversations"],
			},
			prompt: {
				type: "string",
				description:
					"The prompt to send to ChatGPT (required for ask operation)",
			},
                        conversation_id: {
                                type: "string",
                                description:
                                        "Optional conversation ID to continue a specific conversation",
                        },
                        speak: {
                                type: "boolean",
                                description: "Read the ChatGPT response aloud",
                        },
                },
                required: ["operation"],
        },
};

const server = new Server(
	{
		name: "ChatGPT MCP Tool",
		version: "1.0.0",
	},
	{
		capabilities: {
			tools: {},
		},
	},
);

// Check if ChatGPT app is installed and running
export async function checkChatGPTAccess(): Promise<boolean> {
	try {
		const isRunning = await runAppleScript(`
      tell application "System Events"
        return application process "ChatGPT" exists
      end tell
    `);

		if (isRunning !== "true") {
			console.log("ChatGPT app is not running, attempting to launch...");
			try {
				await runAppleScript(`
          tell application "ChatGPT" to activate
          delay 2
        `);
			} catch (activateError) {
				console.error("Error activating ChatGPT app:", activateError);
				throw new Error(
					"Could not activate ChatGPT app. Please start it manually.",
				);
			}
		}

		return true;
	} catch (error) {
		console.error("ChatGPT access check failed:", error);
		throw new Error(
			`Cannot access ChatGPT app. Please make sure ChatGPT is installed and properly configured. Error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

// Function to send a prompt to ChatGPT
async function askChatGPT(
        prompt: string,
        conversationId?: string,
        speak?: boolean,
): Promise<string> {
	await checkChatGPTAccess();
	try {
		// Function to properly encode text for AppleScript, including handling of Chinese characters
		const encodeForAppleScript = (text: string): string => {
			// Only escape double quotes, leave other characters as is
			return text.replace(/"/g, '\\"');
		};

		const encodedPrompt = encodeForAppleScript(prompt);
		
		// Save original clipboard content
		const saveClipboardScript = `
			set savedClipboard to the clipboard
			return savedClipboard
		`;
		const originalClipboard = await runAppleScript(saveClipboardScript);
		const encodedOriginalClipboard = encodeForAppleScript(originalClipboard);
		
		const script = `
      tell application "ChatGPT"
        activate
        delay 1
        tell application "System Events"
          tell process "ChatGPT"
            ${
							conversationId
								? `
              try
                click button "${conversationId}" of group 1 of group 1 of window 1
                delay 1
              end try
            `
								: ""
						}
            -- Clear any existing text in the input field
            keystroke "a" using {command down}
            keystroke (ASCII character 8) -- Delete key
            delay 0.5
            
            -- Set the clipboard to the prompt text
            set the clipboard to "${encodedPrompt}"
            
            -- Paste the prompt and send it
            keystroke "v" using {command down}
            delay 0.5
            keystroke return
            
            -- Wait for the response with dynamic detection
            set maxWaitTime to 120 -- Maximum wait time in seconds
            set waitInterval to 1 -- Check interval in seconds
            set totalWaitTime to 0
            set previousText to ""
            set stableCount to 0
            set requiredStableChecks to 3 -- Number of consecutive stable checks required
            
            repeat while totalWaitTime < maxWaitTime
              delay waitInterval
              set totalWaitTime to totalWaitTime + waitInterval
              
              -- Get current text
              set frontWin to front window
              set allUIElements to entire contents of frontWin
              set conversationText to {}
              repeat with e in allUIElements
                try
                  if (role of e) is "AXStaticText" then
                    set end of conversationText to (description of e)
                  end if
                end try
              end repeat
              
              set AppleScript's text item delimiters to linefeed
              set currentText to conversationText as text
              
              -- Check if text has stabilized (not changing anymore)
              if currentText is equal to previousText then
                set stableCount to stableCount + 1
                if stableCount ≥ requiredStableChecks then
                  -- Text has been stable for multiple checks, assume response is complete
                  exit repeat
                end if
              else
                -- Text changed, reset stable count
                set stableCount to 0
                set previousText to currentText
              end if
              
              -- Check for response completion indicators
              if currentText contains "▍" then
                -- ChatGPT is still typing (blinking cursor indicator)
                set stableCount to 0
              else if currentText contains "Regenerate" or currentText contains "Continue generating" then
                -- Response likely complete if these UI elements are visible
                set stableCount to stableCount + 1
              end if
            end repeat
            
            -- Final check for text content
            if (count of conversationText) = 0 then
              return "No response text found. ChatGPT may still be processing or encountered an error."
            else
              -- Extract just the latest response
              set responseText to ""
              try
                -- Attempt to find the latest response by looking for patterns
                set AppleScript's text item delimiters to linefeed
                set fullText to conversationText as text
                
                -- Look for the prompt in the text to find where the response starts
                set promptPattern to "${prompt.replace(/"/g, '\\"').replace(/\n/g, ' ')}"
                if fullText contains promptPattern then
                  set promptPos to offset of promptPattern in fullText
                  if promptPos > 0 then
                    -- Get text after the prompt
                    set responseText to text from (promptPos + (length of promptPattern)) to end of fullText
                  end if
                end if
                
                -- If we couldn't find the prompt, return the full text
                if responseText is "" then
                  set responseText to fullText
                end if
                
                return responseText
              on error
                -- Fallback to returning all text if parsing fails
                return conversationText as text
              end try
            end if
          end tell
        end tell
      end tell
    `;
		const result = await runAppleScript(script);
		
		// Restore original clipboard content
		await runAppleScript(`set the clipboard to "${encodedOriginalClipboard}"`);
		
		// Post-process the result to clean up any UI text that might have been captured
		let cleanedResult = result
			.replace(/Regenerate( response)?/g, '')
			.replace(/Continue generating/g, '')
			.replace(/▍/g, '')
			.trim();
			
		// More context-aware incomplete response detection
		const isLikelyComplete = 
			cleanedResult.length > 50 || // Longer responses are likely complete
			cleanedResult.endsWith('.') || 
			cleanedResult.endsWith('!') || 
			cleanedResult.endsWith('?') ||
			cleanedResult.endsWith(':') ||
			cleanedResult.endsWith(')') ||
			cleanedResult.endsWith('}') ||
			cleanedResult.endsWith(']') ||
			cleanedResult.includes('\n\n') || // Multiple paragraphs suggest completeness
			/^[A-Z].*[.!?]$/.test(cleanedResult); // Complete sentence structure
			
                if (cleanedResult.length > 0 && !isLikelyComplete) {
                        console.warn("Warning: ChatGPT response may be incomplete");
                }

                if (speak) {
                        exec(`say ${JSON.stringify(cleanedResult)}`);
                }

                return cleanedResult;
        } catch (error) {
		console.error("Error interacting with ChatGPT:", error);
		throw new Error(
			`Failed to get response from ChatGPT: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

// Function to get available conversations
async function getConversations(): Promise<string[]> {
	try {
		// Run AppleScript to get conversations from ChatGPT app
		const result = await runAppleScript(`
      -- Check if ChatGPT is running
      tell application "System Events"
        if not (application process "ChatGPT" exists) then
          return "ChatGPT is not running"
        end if
      end tell

      tell application "ChatGPT"
        -- Activate ChatGPT and give it time to respond
        activate
        delay 1.5

        tell application "System Events"
          tell process "ChatGPT"
            -- Check if ChatGPT window exists
            if not (exists window 1) then
              return "No ChatGPT window found"
            end if
            
            -- Try to get conversation titles with multiple approaches
            set conversationsList to {}
            
            try
              -- First attempt: try buttons in group 1 of group 1
              if exists group 1 of group 1 of window 1 then
                set chatButtons to buttons of group 1 of group 1 of window 1
                repeat with chatButton in chatButtons
                  set buttonName to name of chatButton
                  if buttonName is not "New chat" then
                    set end of conversationsList to buttonName
                  end if
                end repeat
              end if
              
              -- If we didn't find any conversations, try an alternative approach
              if (count of conversationsList) is 0 then
                -- Try to find UI elements by accessibility description
                set uiElements to UI elements of window 1
                repeat with elem in uiElements
                  try
                    if exists (attribute "AXDescription" of elem) then
                      set elemDesc to value of attribute "AXDescription" of elem
                      if elemDesc is not "New chat" and elemDesc is not "" then
                        set end of conversationsList to elemDesc
                      end if
                    end if
                  end try
                end repeat
              end if
              
              -- If still no conversations found, return a specific message
              if (count of conversationsList) is 0 then
                return "No conversations found"
              end if
            on error errMsg
              -- Return error message for debugging
              return "Error: " & errMsg
            end try
            
            return conversationsList
          end tell
        end tell
      end tell
    `);

		// Parse the AppleScript result into an array
		if (result === "ChatGPT is not running") {
			console.error("ChatGPT application is not running");
			throw new Error("ChatGPT application is not running");
		} else if (result === "No ChatGPT window found") {
			console.error("No ChatGPT window found");
			throw new Error("No ChatGPT window found");
		} else if (result === "No conversations found") {
			console.error("No conversations found in ChatGPT");
			return []; // Return empty array instead of error message
		} else if (result.startsWith("Error:")) {
			console.error(result);
			throw new Error(result);
		}
		
		const conversations = result.split(", ");
		return conversations;
	} catch (error) {
		console.error("Error getting ChatGPT conversations:", error);
		throw new Error("Error retrieving conversations: " + (error instanceof Error ? error.message : String(error)));
	}
}

function isChatGPTArgs(args: unknown): args is {
        operation: "ask" | "get_conversations";
        prompt?: string;
        conversation_id?: string;
        speak?: boolean;
} {
        if (typeof args !== "object" || args === null) return false;

        const { operation, prompt, conversation_id, speak } = args as any;

	if (!operation || !["ask", "get_conversations"].includes(operation)) {
		return false;
	}

	// Validate required fields based on operation
	if (operation === "ask" && !prompt) return false;

	// Validate field types if present
        if (prompt && typeof prompt !== "string") return false;
        if (conversation_id && typeof conversation_id !== "string") return false;
        if (speak !== undefined && typeof speak !== "boolean") return false;

	return true;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [CHATGPT_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	try {
		const { name, arguments: args } = request.params;

		if (!args) {
			throw new Error("No arguments provided");
		}

		if (name === "chatgpt") {
			if (!isChatGPTArgs(args)) {
				throw new Error("Invalid arguments for ChatGPT tool");
			}

			switch (args.operation) {
				case "ask": {
					if (!args.prompt) {
						throw new Error("Prompt is required for ask operation");
					}

                                        const response = await askChatGPT(
                                                args.prompt,
                                                args.conversation_id,
                                                args.speak,
                                        );

					return {
						content: [
							{
								type: "text",
								text: response || "No response received from ChatGPT.",
							},
						],
						isError: false,
					};
				}

				case "get_conversations": {
					const conversations = await getConversations();

					return {
						content: [
							{
								type: "text",
								text:
									conversations.length > 0
										? `Found ${conversations.length} conversation(s):\n\n${conversations.join("\n")}`
										: "No conversations found in ChatGPT.",
							},
						],
						isError: false,
					};
				}

				default:
					throw new Error(`Unknown operation: ${args.operation}`);
			}
		}

		return {
			content: [{ type: "text", text: `Unknown tool: ${name}` }],
			isError: true,
		};
	} catch (error) {
		return {
			content: [
				{
					type: "text",
					text: `Error: ${error instanceof Error ? error.message : String(error)}`,
				},
			],
			isError: true,
		};
	}
});

const transport = new StdioServerTransport();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
        await server.connect(transport);
        console.error("ChatGPT MCP Server running on stdio");
}

export { askChatGPT, isChatGPTArgs };
