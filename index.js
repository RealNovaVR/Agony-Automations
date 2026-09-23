require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID.");
  process.exit(1);
}

const MOD_ROLE_IDS = new Set(
  (process.env.MOD_ROLE_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
);

const LINK_ALLOWED_ROLE_IDS = new Set(
  (process.env.LINK_ALLOWED_ROLE_IDS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
);

const LINK_SPAM_WINDOW_MS = Number(process.env.LINK_SPAM_WINDOW_MS || 30000);
const LINK_SPAM_THRESHOLD = Number(process.env.LINK_SPAM_THRESHOLD || 3);
const LINK_TIMEOUT_MINUTES = Number(process.env.LINK_TIMEOUT_MINUTES || 1);
const PORT = Number(process.env.PORT || 3000);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// userId -> timestamps of recent link/image violations
const violationMap = new Map();

function hasAnyRole(member, roleIds) {
  if (!member || !member.roles?.cache) return false;
  return [...roleIds].some(roleId => member.roles.cache.has(roleId));
}

function isLinkAllowed(member) {
  // Server owner is always allowed to post links.
  if (member?.guild?.ownerId === member.id) return true;
  return hasAnyRole(member, LINK_ALLOWED_ROLE_IDS);
}

function isModerator(member) {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  return hasAnyRole(member, MOD_ROLE_IDS);
}

function trimReason(reason) {
  const value = String(reason || "No reason provided").trim();
  return value.length > 450 ? value.slice(0, 447) + "..." : value;
}

function parseDuration(input) {
  const match = String(input).trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const ms = amount * multipliers[unit];

  // Discord timeout max is 28 days.
  if (!Number.isFinite(ms) || ms < 1000 || ms > 28 * 86400000) return null;
  return ms;
}

function looksLikeLink(text) {
  if (!text) return false;

  const normalized = text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[‐‑‒–—―]/g, "-");

  const patterns = [
    /\bhttps?:\/\/\S+/i,
    /\bwww\.\S+/i,
    /\b(?:hxxps?|https?):\/\/\S+/i,
    /\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i,
    /\[[^\]]{1,300}\]\((?:https?:\/\/|www\.)[^)]+\)/i,
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}(?:[/?#][^\s]*)?/i,
    /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#][^\s]*)?/i
  ];

  return patterns.some(pattern => pattern.test(normalized));
}

function isImageMessage(message) {
  if (message.attachments?.some(a => {
    const type = a.contentType || "";
    const name = a.name || "";
    return type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
  })) return true;

  // Discord embeds can represent externally hosted images.
  return message.embeds?.some(embed => Boolean(embed.image?.url || embed.thumbnail?.url));
}

function getRecentViolations(userId) {
  const now = Date.now();
  const recent = (violationMap.get(userId) || []).filter(
    timestamp => now - timestamp <= LINK_SPAM_WINDOW_MS
  );
  violationMap.set(userId, recent);
  return recent;
}

function recordViolation(userId) {
  const recent = getRecentViolations(userId);
  recent.push(Date.now());
  violationMap.set(userId, recent);
  return recent.length;
}

function clearOldViolationEntries() {
  const now = Date.now();
  for (const [userId, timestamps] of violationMap.entries()) {
    const recent = timestamps.filter(t => now - t <= LINK_SPAM_WINDOW_MS);
    if (recent.length === 0) violationMap.delete(userId);
    else violationMap.set(userId, recent);
  }
}

setInterval(clearOldViolationEntries, Math.max(10000, LINK_SPAM_WINDOW_MS));

async function sendModLog(channel, title, description) {
  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Could not send moderation message:", err.message);
  }
}

async function timeoutMember(member, ms, reason) {
  if (!member.moderatable) {
    return { ok: false, error: "I cannot timeout this member. Check role hierarchy and Moderate Members permission." };
  }

  try {
    await member.timeout(ms, reason);
    return { ok: true };
  } catch (err) {
    console.error("Timeout failed:", err);
    return { ok: false, error: "Discord rejected the timeout." };
  }
}

async function banMember(member, reason) {
  if (!member.bannable) {
    return { ok: false, error: "I cannot ban this member. Check role hierarchy and Ban Members permission." };
  }

  try {
    await member.ban({ reason });
    return { ok: true };
  } catch (err) {
    console.error("Ban failed:", err);
    return { ok: false, error: "Discord rejected the ban." };
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member.")
    .addUserOption(option =>
      option.setName("user").setDescription("Member to kick").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("reason").setDescription("Reason for the kick").setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member.")
    .addUserOption(option =>
      option.setName("user").setDescription("Member to ban").setRequired(true)
    )
    .addStringOption(option =>
      option.setName("reason").setDescription("Reason for the ban").setRequired(false)
    )
    .addIntegerOption(option =>
      option
        .setName("delete_message_days")
        .setDescription("Delete 0-7 days of the user's recent messages")
        .setMinValue(0)
        .setMaxValue(7)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member.")
    .addUserOption(option =>
      option.setName("user").setDescription("Member to timeout").setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("duration")
        .setDescription("Examples: 30s, 5m, 1h, 1d (max 28d)")
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName("reason").setDescription("Reason for the timeout").setRequired(false)
    )
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log("Slash commands registered.");
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await registerCommands();
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  if (!isModerator(interaction.member)) {
    return interaction.reply({
      content: "You do not have permission to use moderation commands.",
      ephemeral: true
    });
  }

  const targetUser = interaction.options.getUser("user", true);
  let targetMember;

  try {
    targetMember = await interaction.guild.members.fetch(targetUser.id);
  } catch {
    return interaction.reply({
      content: "That user is not currently a member of this server.",
      ephemeral: true
    });
  }

  if (targetMember.id === interaction.user.id) {
    return interaction.reply({
      content: "You cannot use this command on yourself.",
      ephemeral: true
    });
  }

  if (targetMember.id === interaction.guild.ownerId) {
    return interaction.reply({
      content: "The server owner cannot be moderated by this bot.",
      ephemeral: true
    });
  }

  if (
    interaction.member.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0 &&
    interaction.user.id !== interaction.guild.ownerId
  ) {
    return interaction.reply({
      content: "You cannot moderate someone with an equal or higher role.",
      ephemeral: true
    });
  }

  if (interaction.commandName === "kick") {
    if (!targetMember.kickable) {
      return interaction.reply({
        content: "I cannot kick that member. Check my role hierarchy and Kick Members permission.",
        ephemeral: true
      });
    }

    const reason = trimReason(interaction.options.getString("reason"));
    try {
      await targetMember.kick(reason);
      await interaction.reply(`Kicked **${targetUser.tag}**. Reason: ${reason}`);
    } catch (err) {
      console.error(err);
      await interaction.reply({
        content: "The kick failed. Check my permissions and role hierarchy.",
        ephemeral: true
      });
    }
  }

  if (interaction.commandName === "ban") {
    const reason = trimReason(interaction.options.getString("reason"));
    const deleteDays = interaction.options.getInteger("delete_message_days") ?? 0;

    if (!targetMember.bannable) {
      return interaction.reply({
        content: "I cannot ban that member. Check my role hierarchy and Ban Members permission.",
        ephemeral: true
      });
    }

    try {
      await targetMember.ban({
        reason,
        deleteMessageSeconds: deleteDays * 86400
      });
      await interaction.reply(`Banned **${targetUser.tag}**. Reason: ${reason}`);
    } catch (err) {
      console.error(err);
      await interaction.reply({
        content: "The ban failed. Check my permissions and role hierarchy.",
        ephemeral: true
      });
    }
  }

  if (interaction.commandName === "timeout") {
    const durationInput = interaction.options.getString("duration", true);
    const durationMs = parseDuration(durationInput);
    const reason = trimReason(interaction.options.getString("reason"));

    if (!durationMs) {
      return interaction.reply({
        content: "Invalid duration. Use values like `30s`, `5m`, `1h`, or `1d` (max 28 days).",
        ephemeral: true
      });
    }

    const result = await timeoutMember(targetMember, durationMs, reason);
    if (!result.ok) {
      return interaction.reply({ content: result.error, ephemeral: true });
    }

    await interaction.reply(
      `Timed out **${targetUser.tag}** for **${durationInput}**. Reason: ${reason}`
    );
  }
});

client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;

  const member = message.member;
  if (!member) return;

  // Allowed roles bypass link/image filtering.
  if (isLinkAllowed(member)) return;

  const hasLink = looksLikeLink(message.content);
  const hasImage = isImageMessage(message);

  if (!hasLink && !hasImage) return;

  const wasAlreadyTimedOut = Boolean(member.communicationDisabledUntilTimestamp) &&
    member.communicationDisabledUntilTimestamp > Date.now();

  const violationCount = recordViolation(member.id);
  const isSpam = violationCount >= LINK_SPAM_THRESHOLD;

  try {
    await message.delete();
  } catch (err) {
    console.error("Could not delete violating message:", err.message);
  }

  // If they were already timed out and violate again, ban them.
  if (wasAlreadyTimedOut) {
    const result = await banMember(
      member,
      "Automatic ban: posted a link/image while already timed out for a previous link/image violation."
    );

    if (result.ok) {
      await sendModLog(
        message.channel,
        "Automatic ban",
        `${member.user.tag} was banned after posting a link/image while already timed out.`
      );
    } else {
      await sendModLog(
        message.channel,
        "Automatic moderation failed",
        `I tried to ban ${member.user.tag} after a repeat link/image violation, but Discord rejected the ban: ${result.error}`
      );
    }
    return;
  }

  // First/current violation: timeout for one minute.
  const timeoutResult = await timeoutMember(
    member,
    LINK_TIMEOUT_MINUTES * 60000,
    isSpam
      ? `Automatic timeout: link/image spam (${violationCount} violations in the configured window).`
      : "Automatic timeout: links/images are not allowed."
  );

  if (timeoutResult.ok) {
    await sendModLog(
      message.channel,
      isSpam ? "Link/image spam detected" : "Blocked link/image",
      `${member.user.tag} was timed out for ${LINK_TIMEOUT_MINUTES} minute(s). ` +
      `Recent violations: ${violationCount}.`
    );
  } else {
    await sendModLog(
      message.channel,
      "Automatic timeout failed",
      `I deleted a link/image message from ${member.user.tag}, but could not timeout them: ${timeoutResult.error}`
    );
  }
});

// Tiny web server for Render/UptimeRobot.
const app = express();

app.get("/", (_req, res) => {
  res.status(200).send("Discord moderation bot is running.");
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    discordReady: client.isReady(),
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
});

client.login(TOKEN);
