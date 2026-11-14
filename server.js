const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionContextType,
  ApplicationIntegrationType
} = require("discord.js");

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const https = require("https");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = process.env.PORT || 3000;
const GUILD_ID = process.env.GUILD_ID || "1569479498741579776";
const FULL_COMMAND_ACCESS_ROLE = "1570780402363400262";
const MAIN_ACCESS_ROLE = "1569493916108066966";
const ADMIN_ROLE = "1569494503662821448";
const MOBILE_MAIN_ROLE = "1569493955962216548";
const USERINFO_ROLES = ["1552637829815865414", ADMIN_ROLE, FULL_COMMAND_ACCESS_ROLE];
const RESET_COOLDOWN = 1000 * 60 * 15;
const KEY_LIFETIME = 1000 * 60 * 60 * 24 * 30;
const VALID_SCRIPTS = ["main", "mobile"];

const DB_BASE = (() => {
  if (process.env.RENDER_DISK_PATH) return process.env.RENDER_DISK_PATH;
  try {
    fs.accessSync("/var/data", fs.constants.W_OK);
    return "/var/data";
  } catch {
    return path.join(__dirname, "data");
  }
})();
const DB_PATH = path.join(DB_BASE, "database.json");

const SCRIPTS = {};
const scriptFiles = [
  ["mobile.lua", "mobile"],
  ["main.lua", "main"]
];

for (const [fileName, scriptKey] of scriptFiles) {
  const scriptPath = path.join(__dirname, "scripts", fileName);
  try {
    if (fs.existsSync(scriptPath)) {
      const script = fs.readFileSync(scriptPath, "utf8");
      SCRIPTS[scriptKey] = script;
      console.log("[SCRIPTS] Loaded scripts/" + fileName + " (" + script.length + " bytes)");
    } else {
      SCRIPTS[scriptKey] = "print('" + scriptKey + " script missing')";
      console.error("[SCRIPTS] " + fileName + " not found at: " + scriptPath);
    }
  } catch (e) {
    SCRIPTS[scriptKey] = "print('" + scriptKey + " script failed to load')";
    console.error("[SCRIPTS] Error loading " + fileName + ":", e.message);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("[CRASH SHIELD] Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[CRASH SHIELD] Uncaught Exception:", err);
});

if (!BOT_TOKEN || !CLIENT_ID) {
  console.error("[STARTUP ERROR] Critical environment variables missing.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on("error", (err) => {
  console.error("[DISCORD CLIENT ERROR]", err);
});

function now() {
  return Date.now();
}

function generateKey() {
  const a = Math.random().toString(36).substring(2, 6).toUpperCase();
  const b = Math.random().toString(36).substring(2, 10).toUpperCase();
  const c = Math.random().toString(36).substring(2, 4).toUpperCase();
  return "JAYCE-" + a + "-" + b + "-" + c;
}

function formatDate(ms) {
  const d = new Date(ms);
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
}

function readDB() {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, "{}", "utf8");
      return {};
    }
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (e) {
    console.error("[DATABASE ENGINE CORRUPTION] Auto-repairing sync...", e);
    try { fs.writeFileSync(DB_PATH, "{}", "utf8"); } catch (_) {}
    return {};
  }
}

function writeDB(db) {
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {
    console.error("[DATABASE FILE WRITE FAULT]", e);
  }
}

function safeString(v) {
  if (typeof v !== "string") return null;
  return v.trim().toLowerCase();
}

function getAccountKeys(db) {
  return Object.keys(db).filter((k) => k !== "__meta");
}

function normalizeScriptName(value) {
  const s = (value || "").toString().trim().toLowerCase();
  return VALID_SCRIPTS.includes(s) ? s : null;
}

function getAccountScripts(account) {
  if (!account || !account.allowedScripts) return [];
  if (!Array.isArray(account.allowedScripts)) return [];
  return account.allowedScripts.filter((script) => VALID_SCRIPTS.includes(script));
}

function findAccountByDiscordId(db, discordId) {
  const id = String(discordId);
  for (const name of getAccountKeys(db)) {
    if (db[name] && String(db[name].discordId) === id) return name;
  }
  return null;
}

async function getMemberRoles(userId) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) return null;
    const member = await guild.members.fetch({ user: userId, force: true });
    return member || null;
  } catch (err) {
    console.log("[MEMBER FETCH] Could not fetch member " + userId + ": " + err.message);
    return null;
  }
}

function hasAnyRole(member, roleIds) {
  if (!member || !roleIds || roleIds.length === 0) return false;
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

function hasAccess(member, requiredRoleIds) {
  if (!member) return false;
  if (hasAnyRole(member, [FULL_COMMAND_ACCESS_ROLE])) return true;
  return hasAnyRole(member, requiredRoleIds || []);
}

function getGrantedScriptsForMember(member) {
  const grantedScripts = [];
  if (hasAccess(member, [MOBILE_MAIN_ROLE])) grantedScripts.push("mobile");
  if (hasAccess(member, [MAIN_ACCESS_ROLE])) grantedScripts.push("main");
  return grantedScripts;
}

function getPanelAccessMessage(action) {
  if (action === "main") return "You need the Main role to use the Main button.";
  if (action === "mobilemain") return "You need the Mobile Main role to use the Mobile button.";
  return "You need access to use this button.";
}

function getScriptAccessText(account) {
  const scripts = getAccountScripts(account);
  return scripts.length ? scripts.join(", ") : "none";
}

async function refreshLinkedAccountAccess(db, discordUserId) {
  const accountName = findAccountByDiscordId(db, discordUserId);
  if (!accountName || !db[accountName]) return null;
  const member = await getMemberRoles(discordUserId);
  const granted = getGrantedScriptsForMember(member);
  db[accountName].allowedScripts = granted.length ? granted : ["mobile"];
  writeDB(db);
  return db[accountName];
}

function createLoadHandler(scriptName) {
  return async (req, res) => {
    try {
      const db = readDB();
      if (db.__meta && db.__meta.maintenanceMode) {
        return res.json({ success: false, reason: "**Bot was shut down**" });
      }
      const { username, key, hwid } = req.body;
      const cleanUser = safeString(username);
      if (!cleanUser || typeof key !== "string" || !key.trim() || typeof hwid !== "string" || !hwid.trim()) {
        return res.status(400).json({ success: false, reason: "Username, key, and HWID are required" });
      }

      const user = db[cleanUser];
      if (!user) return res.json({ success: false, reason: "Account not found" });
      if (user.status === "disabled") return res.json({ success: false, reason: "Your account is banned" });
      if (user.key !== key.trim()) return res.json({ success: false, reason: "Invalid Key" });

      const keyCreatedAt = Number(user.keyCreatedAt);
      if (!Number.isFinite(keyCreatedAt) || now() - keyCreatedAt >= KEY_LIFETIME) {
        return res.json({ success: false, reason: "Your key has expired" });
      }
      if (!user.allowedScripts || !user.allowedScripts.includes(scriptName)) {
        return res.json({ success: false, reason: "**No Access**" });
      }

      const cleanHwid = hwid.trim();
      if (!user.hwid) {
        user.hwid = cleanHwid;
        user.hwidLockedAt = now();
      } else if (user.hwid !== cleanHwid) {
        return res.json({ success: false, reason: "HWID mismatch" });
      }

      writeDB(db);
      const scriptCode = SCRIPTS[scriptName];
      if (!scriptCode) return res.json({ success: false, reason: "Script content missing on server files." });

      const encodedScript = JSON.stringify(scriptCode);
      const finalScript = [
        "task.spawn(function()",
        "  local success, err = pcall(function()",
        "    local func, compileErr = loadstring(" + encodedScript + ")",
        "    if not func then error(compileErr or 'Failed to compile script') end",
        "    return func()",
        "  end)",
        "  if not success then error(err or 'Unknown Lua error') end",
        "end)"
      ].join("\n");

      return res.json({ success: true, chunk: finalScript.trim() });
    } catch (err) {
      console.error("[API PROCESS FAILURE] Web execution loop error:", err);
      return res.status(500).json({ success: false, reason: "Something went wrong. Please try again." });
    }
  };
}

app.post("/load/main", createLoadHandler("main"));
app.post("/load/mobile", createLoadHandler("mobile"));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", scriptsLoaded: Object.keys(SCRIPTS).length }));

function createLuaTemplate(u, k, endpoint, displayName) {
  const domain = process.env.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL.replace(/^https?:\/\//, "")
    : (process.env.DOMAIN || "localhost:3000");

  return [
    `-- ${displayName} : -- /jayce Loader`,
    `local USERNAME = "${u}"`,
    `local KEY = "${k}"`,
    `local HWID = game:GetService("RbxAnalyticsService"):GetClientId()`,
    `local HttpService = game:GetService("HttpService")`,
    "",
    "local ok, response = pcall(function()",
    "  local request = (request or (syn and syn.request) or (http and http.request) or (fluxus and fluxus.request))",
    "  if not request then error('Executor does not support HTTP requests.') end",
    "  return request({",
    `    Url = "https://${domain}/load/${endpoint}",`,
    "    Method = 'POST',",
    "    Headers = { ['Content-Type'] = 'application/json' },",
    "    Body = HttpService:JSONEncode({ username = USERNAME, key = KEY, hwid = HWID })",
    "  })",
    "end)",
    "",
    "if not ok then error('[ /f2K8KAdBY5 ] Could not reach server: ' .. tostring(response)) end",
    "",
    "local data = HttpService:JSONDecode(response.Body)",
    "if not data.success then",
    "  if data.reason == 'HWID mismatch' then",
    "    game:GetService('Players').LocalPlayer:Kick('Wrong device detected. Visit discord.gg/f2K8KAdBY5 to reset your HWID.')",
    "  end",
    "  error('[ /f2K8KAdBY5 ] ' .. (data.reason or 'Unknown error'))",
    "end",
    "",
    "loadstring(data.chunk)()"
  ].join("\n");
}

function createPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xEAF4FF)
    .setTitle("☁️ ୨୧ jayce script panel୨୧ ☁️")
    .setDescription(
      "˚₊‧꒰ა Welcome to the heavenly control panel ໒꒱‧₊˚\n\n" +
      "Register an account\n" +
      " Get your key\n" +
      "Main loader\n" +
      " Mobile loader\n" +
      "Reset HWID\n\n" +
      "˚₊‧ May your day be full of sunshine and stardust ‧₊˚"
    )
    .addFields({
      name: " Available Actions",
      value: "Register  ·  Get Key  ·  Main  ·  Mobile  ·  Reset HWID"
    })
    .setFooter({ text: "Made with love and a little stardust " });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("jc_register").setLabel(" Register").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("jc_key").setLabel(" Get Key").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("jc_main").setLabel(" Main").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("jc_mobilemain").setLabel(" Mobile").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("jc_resethwid").setLabel(" Reset HWID").setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row] };
}

function createPanelModal(action) {
  const title = action === "register" ? "Register" : action === "key" ? "Get Key" : action === "main" ? "Main Loader" : action === "mobilemain" ? "Mobile Loader" : "Reset HWID";
  const modal = new ModalBuilder().setCustomId("jc_modal_" + action).setTitle(title);
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("username").setLabel("Username").setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("password").setLabel("Password").setStyle(TextInputStyle.Short).setRequired(true))
  );
  if (action === "main" || action === "mobilemain") {
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("key").setLabel("Key").setStyle(TextInputStyle.Short).setRequired(true)));
  }
  return modal;
}

client.on("interactionCreate", async (interaction) => {
  const member = await getMemberRoles(interaction.user.id);

  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) {
    return;
  }

  if (!interaction.isChatInputCommand() && !hasAccess(member, [ADMIN_ROLE])) {
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp({
        content: "You need the admin role to use this bot.",
        flags: MessageFlags.Ephemeral
      });
    }
    return interaction.reply({
      content: "You need the admin role to use this bot.",
      flags: MessageFlags.Ephemeral
    });
  }

  if (interaction.isButton()) {
    const action = interaction.customId.slice(3);
    if (interaction.customId.startsWith("jc_") && ["register", "key", "main", "mobilemain", "resethwid"].includes(action)) {
      return interaction.showModal(createPanelModal(action));
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (!interaction.customId.startsWith("jc_modal_")) return;
    const action = interaction.customId.slice(9);
    const username = interaction.fields.getTextInputValue("username").trim().toLowerCase();
    const password = interaction.fields.getTextInputValue("password");
    const db = readDB();

    if (!member) return interaction.reply({ content: "You are not in the Jayce server.", flags: MessageFlags.Ephemeral });

    const actionRoleMap = {
      register: [MAIN_ACCESS_ROLE, MOBILE_MAIN_ROLE],
      key: [MAIN_ACCESS_ROLE, MOBILE_MAIN_ROLE],
      main: [MAIN_ACCESS_ROLE],
      mobilemain: [MOBILE_MAIN_ROLE],
      resethwid: [MAIN_ACCESS_ROLE, MOBILE_MAIN_ROLE]
    };

    if (!hasAccess(member, actionRoleMap[action] || [])) {
      return interaction.reply({ content: getPanelAccessMessage(action), flags: MessageFlags.Ephemeral });
    }

    if (action === "register") {
      if (username === "__meta" || db[username]) {
        return interaction.reply({ content: db[username] ? "This username is already taken" : "This username is reserved", flags: MessageFlags.Ephemeral });
      }
      if (getAccountKeys(db).some((name) => db[name].discordId === interaction.user.id)) {
        return interaction.reply({ content: "You already have an account.", flags: MessageFlags.Ephemeral });
      }

      const grantedScripts = getGrantedScriptsForMember(member);
      const createdAt = now();
      db[username] = {
        password,
        key: generateKey(),
        hwid: null,
        hwidLockedAt: null,
        lastHwidReset: 0,
        status: "active",
        allowedScripts: grantedScripts.length ? grantedScripts : ["mobile"],
        discordId: interaction.user.id,
        keyCreatedAt: createdAt
      };
      writeDB(db);
      return interaction.reply({
        content: "**Account Created!**\n• **Username:** `" + username + "`\n• **Key:** `" + db[username].key + "`\n• **Expires On:** " + formatDate(createdAt + KEY_LIFETIME) + "\n• **Scripts:** `" + getScriptAccessText(db[username]) + "`",
        flags: MessageFlags.Ephemeral
      });
    }

    const account = db[username];
    if (!account || account.password !== password) {
      return interaction.reply({ content: "Account not found or incorrect password", flags: MessageFlags.Ephemeral });
    }
    if (account.status === "disabled") {
      return interaction.reply({ content: "This account is banned", flags: MessageFlags.Ephemeral });
    }
    if (action === "key") {
      return interaction.reply({ content: "Your key is: `" + account.key + "`", flags: MessageFlags.Ephemeral });
    }
    if (action === "resethwid") {
      if (now() - (account.lastHwidReset || 0) < RESET_COOLDOWN) {
        return interaction.reply({ content: "Cooldown active. You can reset once every 15 minutes.", flags: MessageFlags.Ephemeral });
      }
      account.hwid = null;
      account.lastHwidReset = now();
      writeDB(db);
      return interaction.reply({ content: "HWID reset!", flags: MessageFlags.Ephemeral });
    }

    const inputKey = interaction.fields.getTextInputValue("key").trim();
    if (account.key !== inputKey) {
      return interaction.reply({ content: "Invalid key.", flags: MessageFlags.Ephemeral });
    }
    const requestedScript = action === "main" ? "main" : "mobile";
    if (!account.allowedScripts.includes(requestedScript)) {
      return interaction.reply({ content: "No access.", flags: MessageFlags.Ephemeral });
    }

    const loader = createLuaTemplate(username, inputKey, requestedScript, requestedScript === "main" ? "Jayce Main" : "Jayce Mobile");
    return interaction.reply({ content: "```lua\n" + loader + "```", flags: MessageFlags.Ephemeral });
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    const db = readDB();
    if (interaction.commandName !== "jayce") return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "panel") {
      if (!hasAccess(await getMemberRoles(interaction.user.id), USERINFO_ROLES)) {
        return interaction.reply({ content: "**No Access**", flags: MessageFlags.Ephemeral });
      }
      return interaction.reply(createPanel());
    }

    if (subcommand === "setpanel") {
      if (!hasAccess(await getMemberRoles(interaction.user.id), USERINFO_ROLES)) {
        return interaction.reply({ content: "**No Access**", flags: MessageFlags.Ephemeral });
      }

      const targetChannel = interaction.options.getChannel("channel");
      if (!targetChannel || typeof targetChannel.send !== "function") {
        return interaction.reply({ content: "Please select a valid text channel.", flags: MessageFlags.Ephemeral });
      }

      await targetChannel.send(createPanel());
      return interaction.reply({ content: "Panel sent to " + targetChannel.toString() + ".", flags: MessageFlags.Ephemeral });
    }

    if (subcommand === "help") {
      return interaction.reply({
        content: "**Jayce Command List**\n" +
          "• `/jayce panel` - open the script panel\n" +
          "• `/jayce accountstatus <username> <password>` - check account status\n" +
          "• `/jayce accountinfo <lookup>` - view another account\n" +
          "• `/jayce changepassword <username> <old_password> <new_password>` - change password\n" +
          "• `/jayce accounts` - list all accounts\n" +
          "• `/jayce stats` - account stats\n" +
          "• `/jayce whois <user>` - locate linked account\n" +
          "• `/jayce grant <username> <main|mobile>` - grant script access\n" +
          "• `/jayce removeaccess <username> <main|mobile>` - revoke script access\n" +
          "• `/jayce revoke <user>` - disable linked account\n" +
          "• `/jayce unsuspend <user>` - re-enable an account\n" +
          "• `/jayce refreshaccess <user>` - refresh access based on Discord roles\n" +
          "• `/jayce togglemaintenance <true|false>` - stop/start bot\n" +
          "• `/jayce resetkey <username>` - rotate key\n" +
          "• `/jayce deleteaccount <username> --confirm` - remove account",
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const currentMember = await getMemberRoles(interaction.user.id);
    if (!currentMember) return interaction.editReply({ content: "Not In Server" });

    if (["showuserinfo", "accountinfo", "accounts", "revoke", "deleteaccount", "resetkey", "stats", "grant", "removeaccess", "suspend", "unsuspend", "whois", "lookupdiscord", "refreshaccess", "togglemaintenance", "setpassword", "lockaccount", "unlockaccount", "maintenance", "help"].includes(subcommand) && !hasAccess(currentMember, USERINFO_ROLES)) {
      return interaction.editReply({ content: "**No Access**" });
    }

    if (["deleteaccount", "resetkey", "grant", "removeaccess", "suspend", "unsuspend", "togglemaintenance", "lookupdiscord", "setpassword"].includes(subcommand) && !hasAccess(currentMember, [ADMIN_ROLE])) {
      return interaction.editReply({ content: "You need the admin role to use this command." });
    }

    if (subcommand === "stats") {
      const accountNames = getAccountKeys(db);
      const accounts = accountNames.map((name) => db[name]).filter(Boolean);
      const activeCount = accounts.filter((account) => account.status !== "disabled").length;
      const disabledCount = accounts.length - activeCount;
      const mainCount = accounts.filter((account) => (account.allowedScripts || []).includes("main")).length;
      const mobileCount = accounts.filter((account) => (account.allowedScripts || []).includes("mobile")).length;
      const lockedCount = accounts.filter((account) => Boolean(account.hwid)).length;
      return interaction.editReply({
        content: "**Jayce Account Stats**\n• Total accounts: **" + accounts.length + "**\n• Active: **" + activeCount + "**\n• Disabled: **" + disabledCount + "**\n• Main access: **" + mainCount + "**\n• Mobile access: **" + mobileCount + "**\n• Device locked: **" + lockedCount + "**",
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === "togglemaintenance") {
      const enabled = interaction.options.getBoolean("enabled");
      if (!db.__meta) db.__meta = {};
      const targetState = enabled !== null && enabled !== undefined ? Boolean(enabled) : !Boolean(db.__meta.maintenanceMode);
      db.__meta.maintenanceMode = targetState;
      writeDB(db);
      return interaction.editReply({ content: targetState ? "**Maintenance mode enabled**" : "**Maintenance mode disabled**" });
    }

    if (subcommand === "deleteaccount") {
      const usernameToDelete = interaction.options.getString("username")?.trim().toLowerCase();
      const confirmed = interaction.options.getBoolean("confirm");
      if (!confirmed) return interaction.editReply({ content: "Account deletion cancelled. Set `confirm` to true to permanently delete the account." });
      if (!usernameToDelete || usernameToDelete === "__meta" || !db[usernameToDelete]) {
        return interaction.editReply({ content: "Account not found." });
      }
      delete db[usernameToDelete];
      writeDB(db);
      return interaction.editReply({ content: "Account `" + usernameToDelete + "` was permanently deleted." });
    }

    if (subcommand === "resetkey") {
      const usernameToReset = interaction.options.getString("username")?.trim().toLowerCase();
      if (!usernameToReset || usernameToReset === "__meta" || !db[usernameToReset]) {
        return interaction.editReply({ content: "Account not found." });
      }
      db[usernameToReset].key = generateKey();
      writeDB(db);
      return interaction.editReply({ content: "Key reset for `" + usernameToReset + "`. The key's current expiration date is unchanged." });
    }

    if (subcommand === "grant") {
      const username = interaction.options.getString("username")?.trim().toLowerCase();
      const script = normalizeScriptName(interaction.options.getString("script"));
      if (!username || username === "__meta" || !db[username]) return interaction.editReply({ content: "Account not found." });
      if (!script) return interaction.editReply({ content: "Use a valid script: `main` or `mobile`." });
      if (!db[username].allowedScripts) db[username].allowedScripts = [];
      if (!db[username].allowedScripts.includes(script)) db[username].allowedScripts.push(script);
      writeDB(db);
      return interaction.editReply({ content: "Granted `" + script + "` access to `" + username + "`." });
    }

    if (subcommand === "removeaccess") {
      const username = interaction.options.getString("username")?.trim().toLowerCase();
      const script = normalizeScriptName(interaction.options.getString("script"));
      if (!username || username === "__meta" || !db[username]) return interaction.editReply({ content: "Account not found." });
      if (!script) return interaction.editReply({ content: "Use a valid script: `main` or `mobile`." });
      db[username].allowedScripts = (db[username].allowedScripts || []).filter((item) => item !== script);
      writeDB(db);
      return interaction.editReply({ content: "Removed `" + script + "` access from `" + username + "`." });
    }

    if (subcommand === "suspend" || subcommand === "revoke") {
      const discordUser = interaction.options.getUser("user");
      if (!discordUser) return interaction.editReply({ content: "Provide a Discord user to revoke." });
      const accountName = findAccountByDiscordId(db, discordUser.id);
      if (accountName && db[accountName]) {
        db[accountName].status = "disabled";
        db[accountName].allowedScripts = [];
        writeDB(db);
      }
      return interaction.editReply({ content: "**Access revoked**\n• **Discord:** " + discordUser.username + "\n• **Loader account:** " + (accountName ? "`" + accountName + "` (disabled)" : "[none]") });
    }

    if (subcommand === "unsuspend") {
      const discordUser = interaction.options.getUser("user");
      if (!discordUser) return interaction.editReply({ content: "Provide a Discord user to restore." });
      const accountName = findAccountByDiscordId(db, discordUser.id);
      if (!accountName || !db[accountName]) {
        return interaction.editReply({ content: "No linked account found for that Discord user." });
      }
      const member = await getMemberRoles(discordUser.id);
      db[accountName].status = "active";
      db[accountName].allowedScripts = getGrantedScriptsForMember(member);
      if (!db[accountName].allowedScripts.length) db[accountName].allowedScripts = ["mobile"];
      writeDB(db);
      return interaction.editReply({ content: "Account `" + accountName + "` has been restored and access refreshed." });
    }

    if (subcommand === "refreshaccess") {
      const targetUser = interaction.options.getUser("user");
      if (!targetUser) return interaction.editReply({ content: "Provide a Discord user to refresh." });
      const refreshed = await refreshLinkedAccountAccess(db, targetUser.id);
      if (!refreshed) return interaction.editReply({ content: "No linked loader account found for that user." });
      return interaction.editReply({ content: "Access refreshed for `" + findAccountByDiscordId(db, targetUser.id) + "`. Current scripts: `" + getScriptAccessText(refreshed) + "`." });
    }

    if (subcommand === "whois" || subcommand === "lookupdiscord") {
      const discordUser = interaction.options.getUser("user");
      if (!discordUser) return interaction.editReply({ content: "Provide a Discord user to lookup." });
      const accountName = findAccountByDiscordId(db, discordUser.id);
      if (!accountName) return interaction.editReply({ content: "No loader account is linked to that Discord user." });
      return interaction.editReply({ content: "**Linked Account**\n• **Discord:** " + discordUser.username + "\n• **Loader:** `" + accountName + "`\n• **Scripts:** `" + getScriptAccessText(db[accountName]) + "`" });
    }

    if (subcommand === "accountinfo" || subcommand === "showuserinfo") {
      const lookupUsername = interaction.options.getString("lookup")?.trim().toLowerCase();
      if (!lookupUsername) return interaction.editReply({ content: "Please enter a username!" });
      if (lookupUsername === "__meta" || !db[lookupUsername]) return interaction.editReply({ content: "Account not found." });
      const account = db[lookupUsername];
      return interaction.editReply({
        content: "**User Info — `" + lookupUsername + "`**\n• **Username:** `" + lookupUsername + "`\n• **Password:** `" + account.password + "`\n• **Key:** `" + account.key + "`\n• **Status:** `" + (account.status || "active") + "`\n• **Device Lock:** `" + (account.hwid ? "Locked" : "Open") + "`\n• **Scripts:** `" + getScriptAccessText(account) + "`\n• **Linked Discord:** `" + (account.discordId || "none") + "`",
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === "accounts") {
      const accountList = getAccountKeys(db);
      if (accountList.length === 0) return interaction.editReply({ content: "No accounts found in the database." });
      const lines = accountList.map((x) => {
        const acct = db[x];
        const status = acct.status || "active";
        const locked = acct.hwid ? "Locked" : "Open";
        const scripts = getScriptAccessText(acct);
        return "• **" + x + "** — Status: `" + status + "` — Device: `" + locked + "` — Scripts: `" + scripts + "`";
      });

      let current = "";
      const chunks = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if ((current + "\n" + line).length > 3900) {
          chunks.push(current);
          current = line;
        } else {
          current = current ? current + "\n" + line : line;
        }
      }
      if (current) chunks.push(current);

      if (chunks.length === 1) {
        return interaction.editReply({ content: "**Registered Accounts (" + accountList.length + ")**\n" + chunks[0] });
      }

      await interaction.editReply({ content: "Found " + accountList.length + " accounts (split across " + chunks.length + " messages):" });
      for (let i = 0; i < chunks.length; i++) {
        await interaction.followUp({ content: "**(" + (i + 1) + "/" + chunks.length + ")**\n" + chunks[i], flags: MessageFlags.Ephemeral });
      }
      return;
    }

    const inputUser = interaction.options.getString("username")?.trim().toLowerCase();
    const inputPass = interaction.options.getString("password");
    const targetUser = inputUser ? db[inputUser] : null;

    function checkCredentials(customUser, customPass) {
      if (customUser === undefined) customUser = targetUser;
      if (customPass === undefined) customPass = inputPass;
      if (!customUser) { interaction.editReply({ content: "Account not found." }).catch(() => {}); return false; }
      if (customUser.password !== customPass) { interaction.editReply({ content: "Incorrect password" }).catch(() => {}); return false; }
      if (customUser.status === "disabled") { interaction.editReply({ content: "This account is banned" }).catch(() => {}); return false; }
      return true;
    }

    if (subcommand === "accountstatus") {
      if (!checkCredentials()) return;
      const keyCreatedAt = targetUser.keyCreatedAt || now();
      const left = Math.max(0, Math.ceil((KEY_LIFETIME - (now() - keyCreatedAt)) / (1000 * 60 * 60 * 24)));
      return interaction.editReply({
        content: "### Account Check: [" + inputUser + "]\n• **Status:** `" + targetUser.status + "`\n• **Device Lock:** `" + (targetUser.hwid ? "Locked" : "Open") + "`\n• **Expires In:** `" + left + " days`\n• **Scripts:** `" + getScriptAccessText(targetUser) + "`",
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === "changepassword") {
      const oldPass = interaction.options.getString("old_password");
      if (!checkCredentials(targetUser, oldPass)) return;
      db[inputUser].password = interaction.options.getString("new_password");
      writeDB(db);
      return interaction.editReply({ content: "Password changed" });
    }

    if (subcommand === "setpassword") {
      const username = interaction.options.getString("username")?.trim().toLowerCase();
      const newPassword = interaction.options.getString("new_password");
      if (!username || !db[username]) return interaction.editReply({ content: "Account not found." });
      if (!newPassword || !newPassword.trim()) return interaction.editReply({ content: "Provide a valid new password." });
      db[username].password = newPassword.trim();
      writeDB(db);
      return interaction.editReply({ content: "Password updated for `" + username + "`." });
    }

    if (subcommand === "lockaccount") {
      const username = interaction.options.getString("username")?.trim().toLowerCase();
      if (!username || !db[username]) return interaction.editReply({ content: "Account not found." });
      db[username].hwid = "manual-lock";
      writeDB(db);
      return interaction.editReply({ content: "Account `" + username + "` has been manually locked." });
    }

    if (subcommand === "unlockaccount") {
      const username = interaction.options.getString("username")?.trim().toLowerCase();
      if (!username || !db[username]) return interaction.editReply({ content: "Account not found." });
      db[username].hwid = null;
      writeDB(db);
      return interaction.editReply({ content: "Account `" + username + "` has been unlocked." });
    }

    return interaction.editReply({ content: "Unknown command." });
  } catch (err) {
    console.error("[CRASH SHIELD] Intercepted interaction fault:", err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "Something went wrong. Check the bot logs." });
      } else {
        await interaction.reply({ content: "Something went wrong. Check the bot logs.", flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}
  }
});

client.on("guildMemberUpdate", async (oldMember, newMember) => {
  try {
    const db = readDB();
    const linkedAccountName = getAccountKeys(db).find((name) => db[name] && String(db[name].discordId) === String(newMember.id));
    if (!linkedAccountName) return;
    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;
    if (oldRoles.size === newRoles.size && [...oldRoles.keys()].every((key) => newRoles.has(key))) return;

    const allowedScripts = getGrantedScriptsForMember(newMember);
    db[linkedAccountName].allowedScripts = allowedScripts.length ? allowedScripts : ["mobile"];
    writeDB(db);
  } catch (err) {
    console.error("[AUTO-SYNC ERROR]", err);
  }
});

function buildCommands() {
  const builder = new SlashCommandBuilder().setName("jayce").setDescription("Loader commands");

  try {
    if (typeof InteractionContextType !== "undefined") {
      builder.setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel);
    } else {
      builder.setContexts(0, 1, 2);
    }
    if (typeof ApplicationIntegrationType !== "undefined") {
      builder.setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall);
    } else {
      builder.setIntegrationTypes(0, 1);
    }
  } catch (e) {
    console.log("[CMDS] Context/integration types not supported:", e.message);
  }

  builder
    .addSubcommand((sub) => sub.setName("help").setDescription("List all Jayce commands"))
    .addSubcommand((sub) => sub.setName("panel").setDescription("Open the Jayce scripts panel"))
    .addSubcommand((sub) => sub.setName("setpanel").setDescription("Send the panel to a selected channel").addChannelOption((o) => o.setName("channel").setDescription("The channel to send the panel to").setRequired(true)))
    .addSubcommand((sub) => sub.setName("accountstatus").setDescription("Check your account status").addStringOption((o) => o.setName("username").setDescription("Your loader username").setRequired(true)).addStringOption((o) => o.setName("password").setDescription("Your loader password").setRequired(true)))
    .addSubcommand((sub) => sub.setName("accountinfo").setDescription("View another account's details").addStringOption((o) => o.setName("lookup").setDescription("The username to inspect").setRequired(true)))
    .addSubcommand((sub) => sub.setName("changepassword").setDescription("Change your password").addStringOption((o) => o.setName("username").setDescription("Your loader username").setRequired(true)).addStringOption((o) => o.setName("old_password").setDescription("Your current password").setRequired(true)).addStringOption((o) => o.setName("new_password").setDescription("Your new password").setRequired(true)))
    .addSubcommand((sub) => sub.setName("showuserinfo").setDescription("View any account's username, password and key").addStringOption((o) => o.setName("lookup").setDescription("The username to inspect").setRequired(true)))
    .addSubcommand((sub) => sub.setName("accounts").setDescription("List all registered accounts"))
    .addSubcommand((sub) => sub.setName("whois").setDescription("Find a linked loader account by Discord user").addUserOption((o) => o.setName("user").setDescription("Discord user to lookup").setRequired(true)))
    .addSubcommand((sub) => sub.setName("revoke").setDescription("Revoke access").addUserOption((o) => o.setName("user").setDescription("Discord user to revoke").setRequired(true)))
    .addSubcommand((sub) => sub.setName("suspend").setDescription("Suspend a linked account").addUserOption((o) => o.setName("user").setDescription("Discord user to suspend").setRequired(true)))
    .addSubcommand((sub) => sub.setName("unsuspend").setDescription("Restore a suspended account").addUserOption((o) => o.setName("user").setDescription("Discord user to restore").setRequired(true)))
    .addSubcommand((sub) => sub.setName("grant").setDescription("Grant script access to an account").addStringOption((o) => o.setName("username").setDescription("The username to edit").setRequired(true)).addStringOption((o) => o.setName("script").setDescription("Script to grant: main or mobile").setRequired(true)))
    .addSubcommand((sub) => sub.setName("removeaccess").setDescription("Remove access from an account").addStringOption((o) => o.setName("username").setDescription("The username to edit").setRequired(true)).addStringOption((o) => o.setName("script").setDescription("Script to remove: main or mobile").setRequired(true)))
    .addSubcommand((sub) => sub.setName("refreshaccess").setDescription("Refresh access based on Discord roles").addUserOption((o) => o.setName("user").setDescription("Discord user to refresh").setRequired(true)))
    .addSubcommand((sub) => sub.setName("deleteaccount").setDescription("Permanently delete a loader account").addStringOption((o) => o.setName("username").setDescription("Username to delete").setRequired(true)).addBooleanOption((o) => o.setName("confirm").setDescription("Confirm permanent deletion").setRequired(true)))
    .addSubcommand((sub) => sub.setName("resetkey").setDescription("Generate a new key for an account").addStringOption((o) => o.setName("username").setDescription("Username whose key to reset").setRequired(true)))
    .addSubcommand((sub) => sub.setName("stats").setDescription("Show loader account statistics"))
    .addSubcommand((sub) => sub.setName("togglemaintenance").setDescription("Enable or disable maintenance mode").addBooleanOption((o) => o.setName("enabled").setDescription("True to enable maintenance mode").setRequired(false)))
    .addSubcommand((sub) => sub.setName("lookupdiscord").setDescription("Lookup the linked account from a Discord user").addUserOption((o) => o.setName("user").setDescription("Discord user to lookup").setRequired(true)))
    .addSubcommand((sub) => sub.setName("setpassword").setDescription("Force set a user's password").addStringOption((o) => o.setName("username").setDescription("Username whose password to change").setRequired(true)).addStringOption((o) => o.setName("new_password").setDescription("New password").setRequired(true)))
    .addSubcommand((sub) => sub.setName("lockaccount").setDescription("Manually lock a user to a HWID").addStringOption((o) => o.setName("username").setDescription("Username to lock").setRequired(true)))
    .addSubcommand((sub) => sub.setName("unlockaccount").setDescription("Unlock a user's device lock").addStringOption((o) => o.setName("username").setDescription("Username to unlock").setRequired(true)));

  const json = builder.toJSON();
  json.dm_permission = true;
  json.contexts = [0, 1, 2];
  json.integration_types = [0, 1];
  return [json];
}

const commandLayouts = buildCommands();

app.listen(PORT, () => {
  console.log("[EXPRESS SERVICE RUNNING] Listening on incoming gateway port " + PORT);
});

const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000;
function startKeepAlive() {
  const urlStr = process.env.RENDER_EXTERNAL_URL || "http://localhost:" + PORT;
  const mod = urlStr.startsWith("https") ? https : http;
  setInterval(() => {
    mod.get(urlStr, { timeout: 5000 }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (j.status === "ok") console.log("[KEEP-ALIVE] Ping successful — " + new Date().toLocaleTimeString());
        } catch (_) {}
      });
    }).on("error", (err) => {
      console.log("[KEEP-ALIVE] Ping failed (expected if just started): " + err.message);
    });
  }, KEEP_ALIVE_INTERVAL);
}
startKeepAlive();

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || message.guild) return;
    const content = (message.content || "").trim();
    if (!content.toLowerCase().startsWith("/jayce") && !content.toLowerCase().startsWith("!jayce")) return;

    const db = readDB();
    const parts = content.split(/\s+/);
    const sub = (parts[1] || "").toLowerCase();

    if (!sub || sub === "help") {
      return message.reply("**Jayce DM commands**\n`!jayce accountstatus <username> <password>`\n`!jayce changepassword <username> <oldpass> <newpass>`\n`!jayce key <username> <password>`\n`!jayce stats`\n`!jayce whois <discord_id>`");
    }

    if (sub === "accountstatus") {
      const username = (parts[2] || "").toLowerCase();
      const password = parts[3];
      const account = db[username];
      if (!account || account.password !== password) return message.reply("Account not found or incorrect password");
      if (account.status === "disabled") return message.reply("This account is banned");
      const keyCreatedAt = account.keyCreatedAt || now();
      const left = Math.max(0, Math.ceil((KEY_LIFETIME - (now() - keyCreatedAt)) / (1000 * 60 * 60 * 24)));
      return message.reply("### Account Check: [" + username + "]\n• **Status:** `" + account.status + "`\n• **Device Lock:** `" + (account.hwid ? "Locked" : "Open") + "`\n• **Expires In:** `" + left + " days`\n• **Scripts:** `" + getScriptAccessText(account) + "`");
    }

    if (sub === "changepassword") {
      const username = (parts[2] || "").toLowerCase();
      const oldPass = parts[3];
      const newPass = parts[4];
      const account = db[username];
      if (!account || account.password !== oldPass) return message.reply("Account not found or incorrect password");
      if (account.status === "disabled") return message.reply("This account is banned");
      if (!newPass) return message.reply("Usage: `!jayce changepassword <username> <oldpass> <newpass>`");
      account.password = newPass;
      writeDB(db);
      return message.reply("Password changed");
    }

    if (sub === "key") {
      const username = (parts[2] || "").toLowerCase();
      const password = parts[3];
      const account = db[username];
      if (!account || account.password !== password) return message.reply("Account not found or incorrect password");
      if (account.status === "disabled") return message.reply("This account is banned");
      return message.reply("Your key is: `" + account.key + "`");
    }

    if (sub === "stats") {
      const accountNames = getAccountKeys(db);
      const accounts = accountNames.map((name) => db[name]).filter(Boolean);
      const activeCount = accounts.filter((account) => account.status !== "disabled").length;
      const mainCount = accounts.filter((account) => (account.allowedScripts || []).includes("main")).length;
      const mobileCount = accounts.filter((account) => (account.allowedScripts || []).includes("mobile")).length;
      return message.reply("**Jayce Account Stats**\n• Total accounts: **" + accounts.length + "**\n• Active: **" + activeCount + "**\n• Main access: **" + mainCount + "**\n• Mobile access: **" + mobileCount + "**");
    }

    if (sub === "whois") {
      const lookupId = parts[2];
      if (!lookupId) return message.reply("Usage: `!jayce whois <discord_id>`");
      const accountName = findAccountByDiscordId(db, lookupId);
      if (!accountName) return message.reply("No linked account found for that Discord user.");
      return message.reply("**Linked Account**\n• **Discord ID:** `" + lookupId + "`\n• **Loader:** `" + accountName + "`\n• **Scripts:** `" + getScriptAccessText(db[accountName]) + "`");
    }

    return message.reply("Unknown subcommand. Type `!jayce help`");
  } catch (err) {
    console.error("[DM MESSAGE CMD ERROR]", err);
    try { await message.reply("Something went wrong."); } catch (_) {}
  }
});

client.once("ready", async () => {
  console.log("[Bot Online] Logged into Discord as " + client.user.tag);
  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
    console.log("[CMDS] Cleared guild commands.");
  } catch (err) {
    console.error("[CMDS] Could not clear guild commands:", err.message);
  }

  try {
    const globalCmds = await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandLayouts });
    console.log("[CMDS] Global commands registered: " + globalCmds.length);
  } catch (err) {
    console.error("[CMDS] Global register FAILED:", err.message);
    if (err.rawError) console.error(JSON.stringify(err.rawError, null, 2));
  }
});

console.log("[LOGIN] Starting Discord login... (token length=" + String(BOT_TOKEN || "").length + ")");
if (!BOT_TOKEN || String(BOT_TOKEN).length < 50) {
  console.error("[LOGIN] BOT_TOKEN looks invalid or too short.");
}

client.login(BOT_TOKEN).then(() => {
  console.log("[LOGIN] client.login() resolved (waiting for ready event)...");
}).catch((err) => {
  console.error("[LOGIN FAILED]", err && err.message ? err.message : err);
  if (err && err.code) console.error("[LOGIN FAILED] code:", err.code);
});
