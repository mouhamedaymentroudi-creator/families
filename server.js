require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const GUILD_ID = process.env.GUILD_ID || '1532179910897045606';
const UNDER_TEST_ROLE_ID = process.env.UNDER_TEST_ROLE_ID || '1532188440190255144';
const GUEST_ROLE_ID = process.env.GUEST_ROLE_ID || '1532188440190255144';
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || '1532404771900882944';
const SUPER_ADMIN = (process.env.SUPER_ADMIN || 'dangerxit77').toLowerCase();

const ADMIN_ROLE_IDS = process.env.ADMIN_ROLE_IDS 
    ? process.env.ADMIN_ROLE_IDS.split(',').map(s => s.trim())
    : ['1532185536096112873', '1532185630371610796', '1532188036681695442'];

// --- DATABASE SETUP (Works seamlessly locally & on Railway /data mount) ---
let DB_FILE;
if (fs.existsSync('/data')) {
    DB_FILE = path.join('/data', 'database.json');
} else {
    DB_FILE = path.join(__dirname, 'database.json');
}

let db = { applications: [], announcements: [] };
if (fs.existsSync(DB_FILE)) {
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        db.applications = Array.isArray(parsed.applications) ? parsed.applications : [];
        db.announcements = Array.isArray(parsed.announcements) ? parsed.announcements : [];
    } catch (e) {
        console.error('[DB] Failed parsing database.json, initializing empty state:', e.message);
        db = { applications: [], announcements: [] };
    }
}

const saveDB = () => {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (err) {
        console.error('[DB WRITE ERROR]', err.message);
    }
};

// --- DISCORD CLIENT INITIALIZATION ---
// Removed GuildPresences to prevent "disallowed intents" errors
const bot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.GuildMember, Partials.User]
});

// --- PASSPORT & SESSION CONFIGURATION ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL || 'https://families-hub-production.up.railway.app/auth/discord/callback',
    scope: ['identify', 'guilds', 'guilds.members.read']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'families-gang-secret-key-2025',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        httpOnly: true,
        sameSite: 'lax'
    }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(__dirname));

// --- ROUTE GUARDS ---
function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized. Please login with Discord.' });
    }
    next();
}

async function requireAdmin(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized.' });
    
    const isSuper = (req.user.username || '').toLowerCase() === SUPER_ADMIN;
    if (isSuper) return next();

    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(req.user.id).catch(() => null);
        const userRoles = member ? member.roles.cache.map(r => r.id) : [];
        const hasAdminRole = ADMIN_ROLE_IDS.some(id => userRoles.includes(id));
        if (hasAdminRole) return next();
    } catch (e) {
        console.error('[AUTH CHECK ERROR]', e.message);
    }
    return res.status(403).json({ error: 'Access denied. Leadership permissions required.' });
}

// --- USER & GENERAL ROUTES ---

app.get('/api/user', async (req, res) => {
    if (!req.user) return res.json({ authenticated: false });

    const isSuper = (req.user.username || '').toLowerCase() === SUPER_ADMIN;
    let isAdmin = isSuper;
    let isMember = isSuper;
    let displayName = req.user.username;
    let roleName = 'Guest';
    let avatarUrl = req.user.avatar 
        ? `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png` 
        : `https://cdn.discordapp.com/embed/avatars/0.png`;

    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(req.user.id).catch(() => null);

        if (member) {
            displayName = member.displayName || req.user.username;
            const userRoleIDs = member.roles.cache.map(r => r.id);
            isAdmin = ADMIN_ROLE_IDS.some(id => userRoleIDs.includes(id)) || isSuper;
            const isUnderTest = userRoleIDs.includes(UNDER_TEST_ROLE_ID);
            isMember = isAdmin || isUnderTest;
            roleName = member.roles.highest && member.roles.highest.name !== '@everyone' 
                ? member.roles.highest.name 
                : 'Guest';
            if (member.user && member.user.displayAvatarURL) {
                avatarUrl = member.user.displayAvatarURL({ dynamic: true });
            }
        }
    } catch (e) {
        console.error('[API USER]', e.message);
    }

    const userApps = db.applications.filter(a => a.userId === req.user.id).sort((a, b) => b.id - a.id);
    const latestApp = userApps[0] || null;

    res.json({
        authenticated: true,
        id: req.user.id,
        username: displayName,
        discordTag: req.user.username,
        avatarUrl,
        isAdmin,
        isMember,
        canSeeAnnouncements: isMember,
        roleName,
        hasApplied: latestApp ? latestApp.status : null,
        appId: latestApp ? latestApp.id.toString().slice(-4) : null,
        latestApp: latestApp ? { status: latestApp.status, date: latestApp.date, note: latestApp.reviewNote } : null
    });
});

app.post('/api/apply', requireAuth, (req, res) => {
    const { q1, q2, q3, q4, q5, q6, q7 } = req.body;
    if (!q1 || !q2 || !q3) {
        return res.status(400).json({ success: false, error: 'Please fill in all mandatory fields.' });
    }

    const pending = db.applications.find(a => a.userId === req.user.id && a.status === 'pending');
    if (pending) {
        return res.status(400).json({ success: false, error: 'You already have an active dossier under review.' });
    }

    const newApp = {
        id: Date.now(),
        userId: req.user.id,
        username: req.user.username,
        date: new Date().toISOString(),
        status: 'pending',
        q1: String(q1).trim(),
        q2: String(q2).trim(),
        q3: String(q3).trim(),
        q4: String(q4 || '').trim(),
        q5: String(q5 || '').trim(),
        q6: String(q6 || '').trim(),
        q7: String(q7 || '').trim()
    };

    db.applications.unshift(newApp);
    saveDB();
    res.json({ success: true, appId: newApp.id.toString().slice(-4) });
});

app.get('/api/announcements', requireAuth, (req, res) => {
    res.json(db.announcements);
});

// --- ADMIN SECURE ROUTES ---

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    const pendingDossiers = db.applications.filter(a => a.status === 'pending').length;
    const totalApplications = db.applications.length;
    let guildMembersCount = 0;
    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        guildMembersCount = guild.memberCount || 0;
    } catch (e) {}
    res.json({
        pendingDossiers,
        totalApplications,
        totalAnnouncements: db.announcements.length,
        guildMembersCount
    });
});

app.get('/api/admin/apps', requireAdmin, (req, res) => {
    const status = req.query.status || 'pending';
    if (status === 'all') {
        return res.json(db.applications);
    }
    res.json(db.applications.filter(a => a.status === status));
});

app.post('/api/admin/decision', requireAdmin, async (req, res) => {
    const { appId, action, reason } = req.body;
    const target = db.applications.find(a => a.id.toString().slice(-4) === appId || a.id.toString() === appId);

    if (!target) {
        return res.status(404).json({ success: false, error: 'Application record not found.' });
    }

    target.status = action;
    target.reviewedBy = req.user.username;
    target.reviewedAt = new Date().toISOString();
    target.reviewNote = reason || '';

    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(target.userId).catch(() => null);

        if (member) {
            if (action === 'accept') {
                if (UNDER_TEST_ROLE_ID) await member.roles.add(UNDER_TEST_ROLE_ID).catch(() => {});
                if (GUEST_ROLE_ID && GUEST_ROLE_ID !== UNDER_TEST_ROLE_ID) {
                    await member.roles.remove(GUEST_ROLE_ID).catch(() => {});
                }
                const emb = new EmbedBuilder()
                    .setTitle('🟢 𝕱𝖆𝖒𝖎𝖑𝖎𝖊𝖘 | APPLICATION ACCEPTED')
                    .setDescription(`Congratulations **${member.displayName}**,\n\nYour dossier has been **approved**. Welcome to the Families.\n\n**Leadership Note:**\n${reason || "Welcome aboard. Abide by our rules at all times."}`)
                    .setColor('#22c55e')
                    .setTimestamp();
                await member.send({ embeds: [emb] }).catch(() => {});
            } else if (action === 'reject') {
                const emb = new EmbedBuilder()
                    .setTitle('🔴 𝕱𝖆𝖒𝖎𝖑𝖎𝖊𝖘 | APPLICATION DECLINED')
                    .setDescription(`Hello **${member.displayName}**,\n\nYour recent application to join Families has been declined.\n\n**Reason:**\n${reason || "Does not meet current gang criteria."}`)
                    .setColor('#ef4444')
                    .setTimestamp();
                await member.send({ embeds: [emb] }).catch(() => {});
            }
        }
    } catch (e) {
        console.error('[DECISION ERROR]', e.message);
    }

    saveDB();
    res.json({ success: true, status: action });
});

app.get('/api/admin/members', requireAdmin, async (req, res) => {
    try {
        const guild = await bot.guilds.fetch(GUILD_ID);
        const members = await guild.members.fetch();
        const list = members
            .filter(m => !m.user.bot)
            .map(m => ({
                id: m.id,
                name: m.displayName || m.user.username,
                avatar: m.user.displayAvatarURL({ size: 64 }),
                role: m.roles.highest && m.roles.highest.name !== '@everyone' ? m.roles.highest.name : "Member",
                rolePos: m.roles.highest ? m.roles.highest.position : 0
            }))
            .sort((a, b) => b.rolePos - a.rolePos);
        res.json(list);
    } catch (e) {
        console.error('[MEMBERS ERROR]', e.message);
        res.json([]);
    }
});

app.post('/api/admin/send-dm', requireAdmin, async (req, res) => {
    const { userIds, message, title } = req.body;
    if (!Array.isArray(userIds) || !userIds.length || !message) {
        return res.status(400).json({ error: 'Recipients or message content missing.' });
    }

    const emb = new EmbedBuilder()
        .setTitle(title || '𝕱𝖆𝖒𝖎𝖑𝖎𝖊𝖘 | DISPATCH')
        .setDescription(message)
        .setColor('#22c55e')
        .setFooter({ text: `Sent by High Command • ${req.user.username}` })
        .setTimestamp();

    let sentCount = 0;
    let failCount = 0;

    for (const id of userIds) {
        try {
            const user = await bot.users.fetch(id);
            await user.send({ embeds: [emb] });
            sentCount++;
        } catch (e) {
            failCount++;
        }
    }

    res.json({ success: true, sentCount, failCount });
});

app.post('/api/admin/announce', requireAdmin, async (req, res) => {
    const { message, title, pingEveryone } = req.body;
    if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Announcement message cannot be empty.' });
    }

    const newAnn = {
        id: Date.now(),
        title: title || 'Global Dispatch',
        message: message.trim(),
        author: req.user.username,
        date: new Date().toISOString()
    };
    db.announcements.unshift(newAnn);
    saveDB();

    let discordSuccess = true;
    try {
        const chan = await bot.channels.fetch(ANNOUNCE_CHANNEL_ID);
        if (chan) {
            const emb = new EmbedBuilder()
                .setTitle(`📢 𝕱𝖆𝖒𝖎𝖑𝖎𝖊𝖘 | ${newAnn.title.toUpperCase()}`)
                .setDescription(newAnn.message)
                .setColor('#22c55e')
                .setFooter({ text: `Announced by ${req.user.username}` })
                .setTimestamp();

            await chan.send({
                content: pingEveryone ? '@everyone' : undefined,
                embeds: [emb]
            });
        }
    } catch (e) {
        console.error('[ANNOUNCE ERROR]', e.message);
        discordSuccess = false;
    }

    res.json({ success: true, discordBroadcasted: discordSuccess });
});

// --- AUTH ROUTING ---
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/'
}), (req, res) => {
    res.redirect('/');
});

app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- START SERVICES ---
if (process.env.BOT_TOKEN) {
    bot.login(process.env.BOT_TOKEN).then(() => {
        console.log(`[BOT] Connected as ${bot.user.tag}`);
    }).catch(err => {
        console.error('[BOT ERROR] Failed to login:', err.message);
        if (err.message.includes('disallowed intents')) {
            console.error('-> FIX: Open Discord Developer Portal -> Bot tab -> Enable SERVER MEMBERS INTENT.');
        }
    });
} else {
    console.warn('[CONFIG] Warning: BOT_TOKEN is not set in .env');
}

app.listen(PORT, () => {
    console.log(`[SERVER] Families Hub running on port ${PORT}`);
});