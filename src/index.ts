import dotenv from "dotenv";
dotenv.config();

import { Telegraf, Markup, Context } from 'telegraf';
import { downloadVoiceFile } from "./lib/downloadVoiceFile";
import { postToWhisper } from "./lib/postToWhisper";
import { textToSpeech,updateAzureTTSRole} from "./lib/azureTTS";
import { createReadStream, existsSync, mkdirSync } from "fs";
import { Model as ChatWithTools } from "./models/chatWithTools";

const workDir = "./tmp";
const telegramToken = process.env.TELEGRAM_TOKEN!;

const bot = new Telegraf(telegramToken);
let model = new ChatWithTools();

if (!existsSync(workDir)) {
  mkdirSync(workDir);
}

type Language = 'en' | 'zh' | 'ja' | 'unknown';

function detectLanguage(text: string): Language {
  if (/[\u4e00-\u9fff]+/.test(text)) {
    // Chinese characters
    return 'zh';
  }
  if (/[\u3040-\u30ff]+/.test(text)) {
    // Japanese characters (Hiragana and Katakana)
    return 'ja';
  }
  if (/[a-zA-Z]+/.test(text)) {
    // English characters
    return 'en';
  }
  return 'unknown';
}

bot.start((ctx) => {
  ctx.reply("Welcome to my Telegram bot!");
});

bot.help((ctx) => {
  ctx.reply("Send me a message and I will echo it back to you.");
});


// Define the list of Azure TTS roles
const azureTTSRoles = [
  'en-US-JaneNeural',
  'en-US-NancyNeural',
  'zh-CN-XiaoxiaoNeural',
  'ja-JP-NanamiNeural',
  'ja-JP-MayuNeural',
  'ja-JP-KeitaNeural'
];

const friendlyRoleNames: Record<string, string> = {
  'en-US-JaneNeural': 'Jane',
  'en-US-NancyNeural': 'Nancy',
  'zh-CN-XiaoxiaoNeural': 'Xiaoxiao',
  'ja-JP-NanamiNeural': 'Nanami',
  'ja-JP-MayuNeural': 'Mayu',
  'ja-JP-KeitaNeural': 'Keita'
};

const languageRoleMapping: Record<Language, string> = {
  en: 'en-US-NancyNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
  unknown: 'en-US-JaneNeural',
};

// Create an inline keyboard for the list of roles
const roleSelectionKeyboard = Markup.inlineKeyboard(
  azureTTSRoles.map((role) => Markup.button.callback(friendlyRoleNames[role], `set_role:${role}`))
);

// Handle the /settings command
bot.command('settings', (ctx) => {
  ctx.reply('Please select an Azure TTS role:', roleSelectionKeyboard);
});

// Handle the callback query when a role is selected
bot.action(/^set_role:(.+)$/, async (ctx) => {
  const selectedRole = ctx.match[1];

  try {
    await updateAzureTTSRole(selectedRole);

    await ctx.answerCbQuery(`Azure TTS role has been updated to: ${selectedRole}`);
  } catch (error) {
    console.log(error);

    await ctx.answerCbQuery(
      "Whoops! There was an error while updating the Azure TTS role."
    );
  }
});


bot.on("voice", async (ctx) => {
  const voice = ctx.message.voice;
  await ctx.sendChatAction("typing");

  let localFilePath;

  try {
    localFilePath = await downloadVoiceFile(workDir, voice.file_id, bot);
  } catch (error) {
    console.log(error);
    await ctx.reply(
      "Whoops! There was an error while downloading the voice file. Maybe ffmpeg is not installed?"
    );
    return;
  }

  const transcription = await postToWhisper(model.openai, localFilePath);

  await ctx.reply(`Transcription: ${transcription}`);
  await ctx.sendChatAction("typing");

  let response;
  try {
    response = await model.call(transcription);
  } catch (error) {
    console.log(error);
    await ctx.reply(
      "Whoops! There was an error while talking to OpenAI. See logs for details."
    );
    return;
  }

  console.log(response);

  await ctx.reply(response);

  try {
    const responseTranscriptionPath = await textToSpeech(response);
    await ctx.sendChatAction("typing");
    await ctx.replyWithVoice({
      source: createReadStream(responseTranscriptionPath),
      filename: localFilePath,
    });
  } catch (error) {
    console.log(error);
    await ctx.reply(
      "Whoops! There was an error while synthesizing the response via play.ht. See logs for details."
    );
  }
});

bot.on("message", async (ctx) => {
  const text = (ctx.message as any).text;

  if (!text) {
    ctx.reply("Please send a text message.");
    return;
  }

  console.log("Input: ", text);

  if (text.startsWith('/mix')) {
    const inputText = text.replace('/mix', '').trim();

    if (!inputText) {
      ctx.reply("Please provide text after the '/mix' command.");
      return;
    }

    if (!text || !text.startsWith('/mix')) {
      ctx.reply("Please send a text message starting with '/mix'.");
      return;
    }
    await handleMixedLanguageResponse(ctx, inputText);
    return;
  }

  if (text.startsWith('/tts')) {
    const inputText = text.replace('/tts', '').trim();

    if (!inputText) {
      ctx.reply("Please provide text after the '/tts' command.");
      return;
    }

    await ctx.sendChatAction("typing");
    try {
      const randomString = Date.now() + Math.floor(Math.random() * 10000);
      const wavDestination = `${workDir}/${randomString}.mp3`;
      const responseTranscriptionPath = await textToSpeech(inputText);
      await ctx.sendChatAction("typing");
      await ctx.replyWithVoice({
        source: createReadStream(responseTranscriptionPath),
        filename: wavDestination,
      });
      return;
    } catch (error) {
      console.log(error);
  
      const message = JSON.stringify(
        (error as any)?.response?.data?.error ?? "Unable to extract error"
      );
  
      console.log({ message });
  
      await ctx.reply(
        "Whoops! There was an error while talking to OpenAI. Error: " + message
      );
    }
  }
  try {
    const response = await model.call(text);
    const detectedLanguage = detectLanguage(response);
    console.log('Detected language: ', detectedLanguage);

    const azureTTSRole = languageRoleMapping[detectedLanguage];
    await updateAzureTTSRole(azureTTSRole);

    const randomString = Date.now() + Math.floor(Math.random() * 10000);
    const wavDestination = `${workDir}/${randomString}.mp3`;
    await ctx.reply(response);
    const responseTranscriptionPath = await textToSpeech(response);
    await ctx.sendChatAction('typing');
    await ctx.replyWithVoice({
      source: createReadStream(responseTranscriptionPath),
      filename: wavDestination,
    });
  } catch (error) {
    console.log(error);

    const message = JSON.stringify(
      (error as any)?.response?.data?.error ?? 'Unable to extract error'
    );

    console.log({ message });

    await ctx.reply(
      'Whoops! There was an error while talking to OpenAI. Error: ' + message
    );
  }

});

bot.launch().then(() => {
  console.log("Bot launched");
});

process.on("SIGTERM", () => {
  bot.stop();
});

async function handleMixedLanguageResponse(ctx: Context, text: string) {
  await ctx.sendChatAction('typing');
  try {
    const response = text;

    // Split the response into segments based on language
    const languagePattern = new RegExp('([\\p{Han}\\p{Hiragana}\\p{Katakana}]+)|([a-zA-Z\\s]+)', 'gu');
    const segments = [...response.matchAll(languagePattern)].map((m) => m[0]);

    // Process each segment and generate voice response
    for (const segment of segments) {
      const detectedLanguage = detectLanguage(segment);

      const azureTTSRole = languageRoleMapping[detectedLanguage];
      await updateAzureTTSRole(azureTTSRole);

      const randomString = Date.now() + Math.floor(Math.random() * 10000);
      const wavDestination = `${workDir}/${randomString}.mp3`;
      await ctx.reply(segment);
      const responseTranscriptionPath = await textToSpeech(segment);
      await ctx.sendChatAction('typing');
      await ctx.replyWithVoice({
        source: createReadStream(responseTranscriptionPath),
        filename: wavDestination,
      });
    }
  } catch (error) {
    console.log(error);

    const message = JSON.stringify(
      (error as any)?.response?.data?.error ?? 'Unable to extract error'
    );

    console.log({ message });

    await ctx.reply(
      'Whoops! There was an error while processing the text. Error: ' + message
    );
  }
}

