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

// Define the ChatGPT tool
const CHATGPT_TOOL: Tool = {
	name: "chatgpt",
	description: "Interact with the ChatGPT desktop app on macOS. Features: 1) 'ask' - Send prompts with customizable wait time (1-30s, default 5s) and get only the last ChatGPT response, 2) 'get_conversations' - List available conversations, 3) 'get_last_message' - Get the complete last ChatGPT response from current conversation",
	inputSchema: {
		type: "object",
		properties: {
			operation: {
				type: "string",
				description: "Operation to perform: 'ask' (send prompt and get last response), 'get_conversations' (list chats), or 'get_last_message' (get complete last ChatGPT response)",
				enum: ["ask", "get_conversations", "get_last_message"],
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
			wait_time: {
				type: "number",
				description:
					"Time in seconds to wait for ChatGPT response (default: 5, max: 30)",
				minimum: 1,
				maximum: 30,
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
async function checkChatGPTAccess(): Promise<boolean> {
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
	waitTime: number = 5,
): Promise<string> {
	await checkChatGPTAccess();
	try {
		// Validate and set wait time
		const safeWaitTime = Math.min(Math.max(waitTime, 1), 30);
		
		// Function to check if text contains Korean characters
		const hasKorean = (text: string): boolean => {
			return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(text);
		};

		// Function to properly encode text for AppleScript, including handling of Chinese characters
		const encodeForAppleScript = (text: string): string => {
			// Only escape double quotes, leave other characters as is
			return text.replace(/"/g, '\\"');
		};

		const encodedPrompt = encodeForAppleScript(prompt);
		const useClipboard = hasKorean(prompt);
		
		const script = `
      tell application "ChatGPT"
        activate
        delay 2
      end tell
      
      tell application "System Events"
        tell process "ChatGPT"
          -- Check if ChatGPT window exists
          if not (exists window 1) then
            return "ChatGPT window not found"
          end if
          
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
          
          -- ChatGPT accepts direct keyboard input, no need to click specific elements
          -- Clear any existing text using key codes
          key code 0 using {command down}  -- cmd+a
          delay 0.5
          key code 51  -- delete key
          delay 1.5
          
          ${useClipboard ? `
          -- Use clipboard + key codes for Korean text
          set the clipboard to "${encodedPrompt}"
          delay 0.5
          key code 9 using {command down}  -- cmd+v
          delay 2
          ` : `
          -- For English text, type directly
          keystroke "${encodedPrompt}"
          delay 2
          `}
          
          -- Send the message using key code
          key code 36  -- return key
          delay 1
          
          -- Wait for ChatGPT to respond (user-specified wait time)
          delay ${safeWaitTime}
          
          -- Get last text element (simple approach like getLastMessage)
          set allElements to entire contents of window 1
          set recentTexts to {}
          
          repeat with elem in allElements
            try
              if (role of elem) is "AXStaticText" then
                set elemText to (description of elem)
                if elemText is not missing value and elemText is not "" then
                  set end of recentTexts to elemText
                end if
              end if
            end try
          end repeat
          
          -- Return last text element
          if (count of recentTexts) > 0 then
            return item -1 of recentTexts
          else
            return "No response received from ChatGPT"
          end if
        end tell
      end tell
    `;
		const result = await runAppleScript(script);
		
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
			console.warn(`Warning: ChatGPT response may be incomplete (waited ${safeWaitTime}s)`);
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

// Function to get the last ChatGPT message
async function getLastMessage(): Promise<string> {
	await checkChatGPTAccess();
	try {
		const script = `
			tell application "ChatGPT"
				activate
				delay 1
			end tell
			
			tell application "System Events"
				tell process "ChatGPT"
					if not (exists window 1) then
						return "ChatGPT window not found"
					end if
					
					-- 마지막 몇개 텍스트 요소만 가져오기 (간단한 버전)
					set allElements to entire contents of window 1
					set recentTexts to {}
					
					repeat with elem in allElements
						try
							if (role of elem) is "AXStaticText" then
								set elemText to (description of elem)
								if elemText is not missing value and elemText is not "" then
									set end of recentTexts to elemText
								end if
							end if
						end try
					end repeat
					
					-- 마지막 텍스트 요소 반환 (가장 간단한 방법)
					if (count of recentTexts) > 0 then
						return item -1 of recentTexts
					else
						return "No messages found"
					end if
				end tell
			end tell
		`;
		
		const result = await runAppleScript(script);
		let cleanedResult = result
			.replace(/Regenerate( response)?/g, '')
			.replace(/Continue generating/g, '')
			.replace(/▍/g, '')
			.trim();
			
		return cleanedResult || "No last message found";
	} catch (error) {
		console.error("Error getting last message from ChatGPT:", error);
		throw new Error(
			`Failed to get last message from ChatGPT: ${
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
	operation: "ask" | "get_conversations" | "get_last_message";
	prompt?: string;
	conversation_id?: string;
	wait_time?: number;
} {
	if (typeof args !== "object" || args === null) return false;

	const { operation, prompt, conversation_id, wait_time } = args as any;

	if (!operation || !["ask", "get_conversations", "get_last_message"].includes(operation)) {
		return false;
	}

	// Validate required fields based on operation
	if (operation === "ask" && !prompt) return false;

	// Validate field types if present
	if (prompt && typeof prompt !== "string") return false;
	if (conversation_id && typeof conversation_id !== "string") return false;
	if (wait_time && typeof wait_time !== "number") return false;

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
						args.wait_time || 5
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

				case "get_last_message": {
					const lastMessage = await getLastMessage();

					return {
						content: [
							{
								type: "text",
								text: lastMessage || "No last message found.",
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

await server.connect(transport);
console.error("ChatGPT MCP Server running on stdio");
