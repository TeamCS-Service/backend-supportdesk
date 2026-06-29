const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const http = require('http');
const socketIo = require('socket.io');
const pool = require('./config/db');
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkeychangeit';
const MAX_CREDIT_AMOUNT = 1_000_000_000_000; // 10^12

// ==================== SAFETY NET: JANGAN BIARKAN PROSES CRASH DIAM-DIAM ====================
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled Promise Rejection (server TIDAK dimatikan):', reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ Uncaught Exception (server TIDAK dimatikan):', err);
});

// ==================== CORS (HANYA SEKALI) ====================
const corsOptions = {
    origin: (origin, callback) => {
        // Izinkan semua localhost dengan port berapa pun
        if (!origin || /^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
            return callback(null, true);
        }
        // Domain production
        const allowedOrigins = [
            'https://remarkable-amazon1.zeven.netlify.app',
            'https://remarkable-maamoul-67e82f.netlify.app',
        ];
        if (allowedOrigins.includes(origin) || /^https?:\/\/(.*\.)?netlify\.app$/.test(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));

app.use(express.json({ limit: '20mb' }));

// ==================== HEADER KEAMANAN ====================
app.use((req, res, next) => {
    // Content Security Policy (CSP) - sesuaikan dengan domain Anda
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' https://cdn.socket.io https://cdnjs.cloudflare.com 'unsafe-inline' 'unsafe-eval'; " +
        "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data: https://ui-avatars.com; " +
        "connect-src 'self' https://generous-liberation-production-dd79.up.railway.app wss://generous-liberation-production-dd79.up.railway.app; " +
        "frame-ancestors 'none';"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// Endpoint health-check
app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
});

// ==================== UPLOAD DIRECTORY (MULTER) ====================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: corsOptions
});

function generateTicketId() {
    return crypto.randomBytes(5).toString('hex');
}

function generateIdeaId() {
    return crypto.randomBytes(5).toString('hex');
}

io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Unauthorized"));
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.user = decoded;
        next();
    } catch (err) {
        next(new Error("Invalid token"));
    }
});

io.on('connection', async (socket) => {
    console.log(`Socket connected: ${socket.user?.id} (${socket.user?.role})`);
    socket.joinedTopics = new Set();

    if (socket.user?.id) {
        try {
            await pool.query('UPDATE users SET is_online = true, last_seen = NOW() WHERE id = $1', [socket.user.id]);
            io.emit('user-status-change', { userId: socket.user.id, isOnline: true });
        } catch (err) {
            console.error('⚠️ Gagal update is_online saat connect:', err.message);
        }
    }

    socket.on('join-user', (userId) => {
        const roomKey = `user_${userId}`;
        socket.join(roomKey);
        console.log(`Socket ${socket.user?.id} joined personal room ${roomKey}`);
    });

    socket.on('join-staff', (staffId) => {
        const roomKey = `user_${staffId}`;
        socket.join(roomKey);
        console.log(`Staff ${socket.user?.id} joined personal room ${roomKey}`);
    });

    socket.on('join-topic', (topicId) => {
        const topicKey = `topic_${topicId}`;
        if (!socket.joinedTopics.has(topicKey)) {
            socket.join(topicKey);
            socket.joinedTopics.add(topicKey);
            console.log(`User ${socket.user?.id} joined ${topicKey}`);
        }
    });

    socket.on('leave-topic', (topicId) => {
        const topicKey = `topic_${topicId}`;
        socket.leave(topicKey);
        socket.joinedTopics.delete(topicKey);
    });

    socket.on('typing', (data) => {
        const { topicId, isTyping, userName } = data;
        socket.to(`topic_${topicId}`).emit('user-typing', { userId: socket.user?.id, userName, isTyping, topicId });
    });

    socket.on('message-read', (data) => {
        const { messageId, topicId } = data;
        socket.to(`topic_${topicId}`).emit('read-receipt', { messageId, userId: socket.user?.id, topicId });
    });

    socket.on('disconnect', async () => {
        console.log(`Socket disconnected: ${socket.user?.id}`);
        if (socket.user?.id) {
            try {
                await pool.query('UPDATE users SET is_online = false, last_seen = NOW() WHERE id = $1', [socket.user.id]);
                io.emit('user-status-change', { userId: socket.user.id, isOnline: false });
            } catch (err) {
                console.error('⚠️ Gagal update is_online saat disconnect:', err.message);
            }
        }
        socket.joinedTopics.clear();
    });
});

function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

async function canAccessTopic(userId, topicId, role) {
    const participant = await pool.query(
        'SELECT 1 FROM chat_participants WHERE topic_id = $1 AND user_uid = $2',
        [topicId, String(userId)]
    );
    if (participant.rows.length > 0) return true;
    if (['admin', 'super_admin', 'staff', 'agent'].includes(role)) {
        const topicCheck = await pool.query('SELECT 1 FROM chat_topics WHERE topic_id = $1', [topicId]);
        return topicCheck.rows.length > 0;
    }
    return false;
}

// ==================== MIGRASI ====================
(async function migrate() {
    try {
        const check = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='chat_messages' AND column_name='files'
        `);
        if (check.rows.length === 0) {
            await pool.query(`ALTER TABLE chat_messages ADD COLUMN files JSONB DEFAULT '[]'`);
            console.log('✅ Added files column to chat_messages');
        } else {
            console.log('✅ files column already exists');
        }
    } catch (err) {
        console.warn('⚠️ Migration warning:', err.message);
    }
})();

(async function migrateIsSystem() {
    try {
        const check = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='chat_messages' AND column_name='is_system'
        `);
        if (check.rows.length === 0) {
            await pool.query(`ALTER TABLE chat_messages ADD COLUMN is_system BOOLEAN DEFAULT false`);
            console.log('✅ Added is_system column to chat_messages');
        } else {
            console.log('✅ is_system column already exists');
        }
    } catch (err) {
        console.warn('⚠️ Migration warning:', err.message);
    }
})();

(async function migrateChatNotes() {
    try {
        const checkTable = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_name='chat_notes'
        `);
        if (checkTable.rows.length === 0) {
            await pool.query(`
                CREATE TABLE chat_notes (
                    id SERIAL PRIMARY KEY,
                    topic_id INTEGER NOT NULL REFERENCES chat_topics(topic_id) ON DELETE CASCADE,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    note TEXT NOT NULL,
                    is_internal BOOLEAN DEFAULT true,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);
            console.log('✅ Created chat_notes table');
        } else {
            const columns = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name='chat_notes'
            `);
            const colNames = columns.rows.map(r => r.column_name);
            if (!colNames.includes('user_id')) {
                await pool.query(`
                    ALTER TABLE chat_notes ADD COLUMN user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
                `);
                console.log('✅ Added user_id column to chat_notes');
            }
            if (!colNames.includes('topic_id')) {
                await pool.query(`
                    ALTER TABLE chat_notes ADD COLUMN topic_id INTEGER NOT NULL REFERENCES chat_topics(topic_id) ON DELETE CASCADE
                `);
                console.log('✅ Added topic_id column to chat_notes');
            }
            if (!colNames.includes('note')) {
                await pool.query(`ALTER TABLE chat_notes ADD COLUMN note TEXT NOT NULL`);
                console.log('✅ Added note column to chat_notes');
            }
            if (!colNames.includes('is_internal')) {
                await pool.query(`ALTER TABLE chat_notes ADD COLUMN is_internal BOOLEAN DEFAULT true`);
                console.log('✅ Added is_internal column to chat_notes');
            }
            if (!colNames.includes('created_at')) {
                await pool.query(`ALTER TABLE chat_notes ADD COLUMN created_at TIMESTAMP DEFAULT NOW()`);
                console.log('✅ Added created_at column to chat_notes');
            }
            console.log('✅ chat_notes table up-to-date');
        }
    } catch (err) {
        console.warn('⚠️ Migration warning (chat_notes):', err.message);
    }
})();

(async function migrateResolvedAt() {
    try {
        const check = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='chat_topics' AND column_name='resolved_at'
        `);
        if (check.rows.length === 0) {
            await pool.query(`ALTER TABLE chat_topics ADD COLUMN resolved_at TIMESTAMP`);
            console.log('✅ Added resolved_at column to chat_topics');
        }
        const checkStatus = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='chat_topics' AND column_name='status'
        `);
        if (checkStatus.rows.length === 0) {
            await pool.query(`ALTER TABLE chat_topics ADD COLUMN status VARCHAR(50) DEFAULT 'active'`);
            console.log('✅ Added status column to chat_topics');
        }
    } catch (err) {
        console.warn('⚠️ Migration warning (resolved_at):', err.message);
    }
})();

(async function migrateAssignedAgent() {
    try {
        const check = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='chat_topics' AND column_name='assigned_agent_id'
        `);
        if (check.rows.length === 0) {
            await pool.query(`ALTER TABLE chat_topics ADD COLUMN assigned_agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL`);
            console.log('✅ Added assigned_agent_id column to chat_topics');
        }
    } catch (err) {
        console.warn('⚠️ Migration warning (assigned_agent_id):', err.message);
    }
})();

(async function migrateLastSenderRole() {
    try {
        const check = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='chat_topics' AND column_name='last_sender_role'
        `);
        if (check.rows.length === 0) {
            await pool.query(`ALTER TABLE chat_topics ADD COLUMN last_sender_role VARCHAR(20)`);
            console.log('✅ Added last_sender_role column to chat_topics');
        }
        const checkSenderName = await pool.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='chat_topics' AND column_name='last_message_sender_name'
        `);
        if (checkSenderName.rows.length === 0) {
            await pool.query(`ALTER TABLE chat_topics ADD COLUMN last_message_sender_name VARCHAR(255)`);
            console.log('✅ Added last_message_sender_name column to chat_topics');
        }
    } catch (err) {
        console.warn('⚠️ Migration warning (last_sender_role):', err.message);
    }
})();

(async function migrateSolvedMaintenanceUpdated() {
    try {
        const check = await pool.query(`
            SELECT table_name FROM information_schema.tables WHERE table_name='solved_maintenance'
        `);
        if (check.rows.length > 0) {
            const colCheck = await pool.query(`
                SELECT column_name FROM information_schema.columns 
                WHERE table_name='solved_maintenance' AND column_name='date_updated'
            `);
            if (colCheck.rows.length === 0) {
                await pool.query(`ALTER TABLE solved_maintenance ADD COLUMN date_updated TIMESTAMP`);
                console.log('✅ Added date_updated column to solved_maintenance');
            }
        }
    } catch (err) {
        console.warn('⚠️ Migration warning (solved_maintenance):', err.message);
    }
})();

// ==================== SEED GLOBAL TOPICS ====================
(async function seedGlobalTopics() {
    try {
        const check = await pool.query(
            `SELECT COUNT(*) FROM chat_topics WHERE created_by IS NULL`
        );
        if (parseInt(check.rows[0].count) === 0) {
            const defaultTopics = [
                { name: 'General', desc: 'Topik umum untuk semua pertanyaan', icon: 'fa-comment', color: '#6366f1' },
                { name: 'Billing', desc: 'Pertanyaan terkait tagihan dan pembayaran', icon: 'fa-credit-card', color: '#10b981' },
                { name: 'Technical', desc: 'Masalah teknis dan bug', icon: 'fa-code', color: '#f59e0b' },
                { name: 'Feature Request', desc: 'Saran untuk fitur baru', icon: 'fa-lightbulb', color: '#8b5cf6' }
            ];
            for (const t of defaultTopics) {
                await pool.query(
                    `INSERT INTO chat_topics (topic_name, topic_description, topic_icon, topic_color, created_by, created_at)
                     VALUES ($1, $2, $3, $4, NULL, NOW())`,
                    [t.name, t.desc, t.icon, t.color]
                );
            }
            console.log('✅ Seeded default global topics');
        } else {
            console.log('✅ Global topics already exist');
        }
    } catch (err) {
        console.warn('⚠️ Seeding global topics warning:', err.message);
    }
})();

async function createPrivateTopicsForUser(userId, userName) {
    const globalTopics = await pool.query(
        `SELECT DISTINCT ON (topic_name) topic_name, topic_description, 
                topic_icon, topic_color 
         FROM chat_topics 
         WHERE created_by IS NULL
         ORDER BY topic_name, topic_id ASC`
    );

    for (const global of globalTopics.rows) {
        const existing = await pool.query(
            `SELECT topic_id FROM chat_topics 
             WHERE created_by = $1 AND topic_name = $2`,
            [userId, global.topic_name]
        );
        if (existing.rows.length > 0) continue;

        const insertTopic = await pool.query(
            `INSERT INTO chat_topics 
                (topic_name, topic_description, topic_icon, topic_color, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT DO NOTHING
             RETURNING topic_id`,
            [global.topic_name, global.topic_description,
             global.topic_icon, global.topic_color, userId]
        );

        if (!insertTopic.rows[0]) continue;

        const newTopicId = insertTopic.rows[0].topic_id;

        await pool.query(
            `INSERT INTO chat_participants (topic_id, user_uid, user_name, role, last_read_at)
             VALUES ($1, $2, $3, 'user', NOW()) ON CONFLICT DO NOTHING`,
            [newTopicId, String(userId), userName]
        );

        await pool.query(
            `INSERT INTO chat_participants (topic_id, user_uid, user_name, role, last_read_at)
             SELECT $1, id::VARCHAR, name, 'staff', NOW() FROM users
             WHERE role IN ('staff', 'agent', 'admin', 'super_admin')
             ON CONFLICT DO NOTHING`,
            [newTopicId]
        );
    }
    console.log(`✅ Created private topics for user ${userName} (ID:${userId})`);
}

// ==================== AUTH ROUTES ====================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, role = 'user' } = req.body;
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Email sudah terdaftar' });
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (name, email, password_hash, role, display_name, created_date, last_updated)
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING id, name, email, role`,
            [name, email, hashedPassword, role, name]
        );
        const newUser = result.rows[0];
        
        if (newUser.role !== 'super_admin') {
            await createPrivateTopicsForUser(newUser.id, newUser.name);
        }

        const token = jwt.sign({ id: newUser.id, email: newUser.email, role: newUser.role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, user: newUser, token });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Email tidak ditemukan' });
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ error: 'Password salah' });
        await pool.query('UPDATE users SET last_login = NOW(), last_seen = NOW() WHERE id = $1', [user.id]);
        const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role }, token });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/change-password', verifyToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userRes = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const valid = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
        if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
        if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
        const newHash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1, last_updated = NOW() WHERE id = $2', [newHash, req.user.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/me', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, email, role, display_name, profile_image FROM users WHERE id = $1',
            [req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ user: result.rows[0] });
    } catch (err) {
        console.error('Error fetching current user:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/auth/update-profile', verifyToken, async (req, res) => {
    try {
        const { name, profile_image } = req.body;
        const result = await pool.query(
            `UPDATE users SET
                name = COALESCE($1, name),
                display_name = COALESCE($1, display_name),
                profile_image = COALESCE($2, profile_image),
                last_updated = NOW()
             WHERE id = $3 RETURNING id, name, email, role, display_name, profile_image`,
            [name || null, profile_image || null, req.user.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        console.error('Error updating profile:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== CHAT ROUTES ====================
app.get('/api/user/topics/:userId', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        if (req.user.id != userId && !['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query(
            `SELECT DISTINCT ON (ct.topic_name) ct.*, 
                COALESCE(
                    (SELECT COUNT(*) FROM chat_messages cm 
                     WHERE cm.topic_id = ct.topic_id 
                       AND cm.sender_role = 'staff'
                       AND cm.created_at > COALESCE(cp.last_read_at, '1970-01-01')
                    ), 0
                ) as unread_count,
                ct.last_message_sender_name as last_sender_name,
                (SELECT sender_role FROM chat_messages WHERE topic_id = ct.topic_id ORDER BY created_at DESC LIMIT 1) as last_sender_role
             FROM chat_topics ct
             LEFT JOIN chat_participants cp ON cp.topic_id = ct.topic_id AND cp.user_uid = $1
             WHERE ct.created_by = $2
             ORDER BY ct.topic_name, ct.last_message_time DESC NULLS LAST`,
            [String(userId), userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching user topics:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user/topics/:userId/create', verifyToken, async (req, res) => {
    try {
        const { userId } = req.params;
        if (req.user.id != userId && !['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { topic_name, topic_description } = req.body;
        if (!topic_name) {
            return res.status(400).json({ error: 'Topic name is required' });
        }

        const userCheck = await pool.query('SELECT name FROM users WHERE id = $1', [userId]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        const userName = userCheck.rows[0].name;

        const topicColor = '#6366f1';
        const topicIcon = 'fa-comment';
        const result = await pool.query(
            `INSERT INTO chat_topics (topic_name, topic_description, topic_icon, topic_color, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING topic_id`,
            [topic_name, topic_description || '', topicIcon, topicColor, userId]
        );
        const topicId = result.rows[0].topic_id;

        await pool.query(
            `INSERT INTO chat_participants (topic_id, user_uid, user_name, role, last_read_at)
             VALUES ($1, $2, $3, 'user', NOW()) ON CONFLICT DO NOTHING`,
            [topicId, String(userId), userName]
        );

        await pool.query(
            `INSERT INTO chat_participants (topic_id, user_uid, user_name, role, last_read_at)
             SELECT $1, id::VARCHAR, name, 'staff', NOW() FROM users
             WHERE role IN ('staff', 'agent', 'admin', 'super_admin')
             ON CONFLICT DO NOTHING`,
            [topicId]
        );

        res.status(201).json({ success: true, topic_id: topicId });
    } catch (err) {
        console.error('Error creating user topic:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/staff/topics', verifyToken, async (req, res) => {
    try {
        if (!['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query(
            `SELECT ct.*, u.name as user_name, u.email as user_email, u.id as user_id,
                COALESCE(
                    (SELECT COUNT(*) FROM chat_messages cm 
                     WHERE cm.topic_id = ct.topic_id 
                       AND cm.sender_role = 'user'
                       AND cm.created_at > COALESCE(cp.last_read_at, '1970-01-01')
                    ), 0
                ) as unread_count,
                (SELECT sender_role FROM chat_messages WHERE topic_id = ct.topic_id ORDER BY created_at DESC LIMIT 1) as last_sender_role
             FROM chat_topics ct
             JOIN users u ON u.id = ct.created_by
             LEFT JOIN chat_participants cp ON cp.topic_id = ct.topic_id AND cp.user_uid = $1
             WHERE ct.created_by IS NOT NULL
             ORDER BY ct.last_message_time DESC NULLS LAST`,
            [String(req.user.id)]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching staff topics:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/topic/:topicId/messages', verifyToken, async (req, res) => {
    try {
        const { topicId } = req.params;
        const hasAccess = await canAccessTopic(req.user.id, topicId, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });
        const result = await pool.query(
            `SELECT id, topic_id, sender_uid, sender_name, sender_role, message, files, is_system, created_at 
             FROM chat_messages 
             WHERE topic_id = $1 
             ORDER BY created_at ASC`,
            [topicId]
        );
        const rows = result.rows.map(row => ({ ...row, files: row.files || [] }));
        res.json(rows);
    } catch (err) {
        console.error('Error fetching messages:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/topic/:topicId/message', verifyToken, async (req, res) => {
    try {
        const { topicId } = req.params;
        const { message, files, isSystem } = req.body;
        if (!message || message.trim().length === 0) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }
        const hasAccess = await canAccessTopic(req.user.id, topicId, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

        let senderName = req.user.name;
        if (!senderName) {
            const userRes = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
            senderName = userRes.rows[0]?.name || 'User';
        }

        const senderRole = ['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role) ? 'staff' : 'user';
        const filesJson = JSON.stringify(files || []);
        const isSystemValue = isSystem === true;

        const result = await pool.query(
            `INSERT INTO chat_messages 
             (topic_id, sender_uid, sender_name, sender_role, message, files, is_system, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id, created_at`,
            [topicId, String(req.user.id), senderName, senderRole, message, filesJson, isSystemValue]
        );
        const newMsg = result.rows[0];

        await pool.query(
            `UPDATE chat_topics SET last_message = $1, last_message_sender_name = $2, last_message_time = NOW(), last_sender_role = $3 WHERE topic_id = $4`,
            [message, senderName, senderRole, topicId]
        );

        const fullMessage = {
            id: newMsg.id,
            topic_id: parseInt(topicId),
            sender_uid: String(req.user.id),
            sender_name: senderName,
            sender_role: senderRole,
            message: message,
            files: files || [],
            is_system: isSystemValue,
            created_at: newMsg.created_at
        };

        io.to(`topic_${topicId}`).emit('new-message', fullMessage);

        if (senderRole === 'staff') {
            try {
                const topicOwner = await pool.query(
                    'SELECT created_by, topic_name FROM chat_topics WHERE topic_id = $1', [topicId]
                );
                if (topicOwner.rows.length > 0 && topicOwner.rows[0].created_by) {
                    const ownerId = topicOwner.rows[0].created_by;
                    const tName = topicOwner.rows[0].topic_name || 'Percakapan';
                    const msgWithTopic = { ...fullMessage, topic_name: tName };
                    io.to(`user_${ownerId}`).emit('new-message', msgWithTopic);
                    console.log(`[Socket] Notif -> user_${ownerId} (topic_${topicId})`);
                }
            } catch (ownerErr) {
                console.error('⚠️ Gagal emit ke user room:', ownerErr.message);
            }
        } else {
            try {
                const topicData = await pool.query(
                    'SELECT assigned_agent_id, topic_name, created_by FROM chat_topics WHERE topic_id = $1',
                    [topicId]
                );
                const tName = topicData.rows[0]?.topic_name || 'Percakapan';
                const msgWithTopic = { ...fullMessage, topic_name: tName };

                const notifiedSet = new Set();

                const assignedAgentId = topicData.rows[0]?.assigned_agent_id;
                if (assignedAgentId && String(assignedAgentId) !== String(req.user.id)) {
                    io.to(`user_${assignedAgentId}`).emit('new-message', msgWithTopic);
                    notifiedSet.add(String(assignedAgentId));
                    console.log(`[Socket] Notif -> assigned agent user_${assignedAgentId} (topic_${topicId})`);
                }

                const admins = await pool.query(
                    `SELECT id FROM users WHERE role IN ('admin', 'super_admin') AND id != $1`,
                    [req.user.id]
                );
                for (const admin of admins.rows) {
                    const adminKey = String(admin.id);
                    if (!notifiedSet.has(adminKey)) {
                        io.to(`user_${admin.id}`).emit('new-message', msgWithTopic);
                        notifiedSet.add(adminKey);
                    }
                }

                if (!assignedAgentId) {
                    const staffList = await pool.query(
                        `SELECT id FROM users WHERE role IN ('staff', 'agent') AND id != $1`,
                        [req.user.id]
                    );
                    for (const staff of staffList.rows) {
                        const staffKey = String(staff.id);
                        if (!notifiedSet.has(staffKey)) {
                            io.to(`user_${staff.id}`).emit('new-message', msgWithTopic);
                            notifiedSet.add(staffKey);
                        }
                    }
                }
            } catch (notifErr) {
                console.error('⚠️ Gagal emit notif ke staff/agent:', notifErr.message);
            }
        }

        res.json({ success: true, message: fullMessage });
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/mark-read/:topicId', verifyToken, async (req, res) => {
    try {
        const { topicId } = req.params;
        const result = await pool.query(
            `UPDATE chat_participants SET last_read_at = NOW() WHERE topic_id = $1 AND user_uid = $2 RETURNING id`,
            [topicId, String(req.user.id)]
        );
        if (result.rows.length === 0) {
            const userRes = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
            const userName = userRes.rows[0]?.name || 'User';
            const role = ['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role) ? 'staff' : 'user';
            await pool.query(
                `INSERT INTO chat_participants (topic_id, user_uid, user_name, role, last_read_at)
                 VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (topic_id, user_uid) DO UPDATE SET last_read_at = NOW()`,
                [topicId, String(req.user.id), userName, role]
            );
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Mark read error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/topic/:topicId/resolve', verifyToken, async (req, res) => {
    try {
        const { topicId } = req.params;
        if (!['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const hasAccess = await canAccessTopic(req.user.id, topicId, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

        await pool.query(
            `UPDATE chat_topics SET status = 'resolved', resolved_at = NOW() WHERE topic_id = $1`,
            [topicId]
        );

        const senderName = req.user.name || 'Staff';
        const resolveMsg = `Percakapan ini telah diselesaikan oleh ${senderName}`;
        const msgResult = await pool.query(
            `INSERT INTO chat_messages (topic_id, sender_uid, sender_name, sender_role, message, files, is_system, created_at)
             VALUES ($1, $2, $3, 'staff', $4, '[]', true, NOW()) RETURNING id, created_at`,
            [topicId, String(req.user.id), senderName, resolveMsg]
        );

        const fullMessage = {
            id: msgResult.rows[0].id,
            topic_id: parseInt(topicId),
            sender_uid: String(req.user.id),
            sender_name: senderName,
            sender_role: 'staff',
            message: resolveMsg,
            files: [],
            is_system: true,
            created_at: msgResult.rows[0].created_at
        };
        io.to(`topic_${topicId}`).emit('new-message', fullMessage);

        try {
            const topicOwner2 = await pool.query(
                'SELECT created_by FROM chat_topics WHERE topic_id = $1', [topicId]
            );
            if (topicOwner2.rows.length > 0 && topicOwner2.rows[0].created_by) {
                io.to(`user_${topicOwner2.rows[0].created_by}`).emit('new-message', fullMessage);
            }
        } catch (e) { console.error('⚠️ Resolve emit user room error:', e.message); }

        res.json({ success: true });
    } catch (err) {
        console.error('Resolve topic error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== UPLOAD FILE ====================
app.post('/api/upload', verifyToken, (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            console.error('Upload (multer) error:', err.message);
            return res.status(400).json({ error: err.message });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        try {
            res.json({
                success: true,
                file: {
                    name: req.file.originalname,
                    url: `/uploads/${req.file.filename}`,
                    size: req.file.size,
                    type: req.file.mimetype
                }
            });
        } catch (err2) {
            console.error('Upload error:', err2);
            res.status(500).json({ error: err2.message });
        }
    });
});

// ==================== CATATAN INTERNAL ====================
app.post('/api/chat/notes', verifyToken, async (req, res) => {
    try {
        const { topic_id, note, is_internal } = req.body;
        if (!topic_id || !note) {
            return res.status(400).json({ error: 'topic_id and note are required' });
        }
        const hasAccess = await canAccessTopic(req.user.id, topic_id, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

        const result = await pool.query(
            `INSERT INTO chat_notes (topic_id, user_id, note, is_internal, created_at)
             VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
            [topic_id, req.user.id, note, is_internal !== undefined ? is_internal : true]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error saving note:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/chat/notes/:topicId', verifyToken, async (req, res) => {
    try {
        const { topicId } = req.params;
        const hasAccess = await canAccessTopic(req.user.id, topicId, req.user.role);
        if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

        if (['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            const result = await pool.query(
                'SELECT * FROM chat_notes WHERE topic_id = $1 ORDER BY created_at ASC',
                [topicId]
            );
            res.json(result.rows);
        } else {
            const result = await pool.query(
                'SELECT * FROM chat_notes WHERE topic_id = $1 AND is_internal = false ORDER BY created_at ASC',
                [topicId]
            );
            res.json(result.rows);
        }
    } catch (err) {
        console.error('Error fetching notes:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== ASSIGN AGENT ====================
app.post('/api/chat/assign', verifyToken, async (req, res) => {
    try {
        const { topic_id, agent_id } = req.body;
        if (!topic_id) {
            return res.status(400).json({ error: 'topic_id is required' });
        }
        if (!['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const topic = await pool.query('SELECT topic_id FROM chat_topics WHERE topic_id = $1', [topic_id]);
        if (topic.rows.length === 0) {
            return res.status(404).json({ error: 'Topic not found' });
        }

        let agentIdInt = null;
        if (agent_id !== null && agent_id !== undefined && agent_id !== '') {
            const parsed = parseInt(agent_id, 10);
            if (isNaN(parsed) || parsed <= 0) {
                return res.status(400).json({ error: 'Agent ID must be a valid number' });
            }
            agentIdInt = parsed;

            const agent = await pool.query(
                `SELECT id FROM users WHERE id = $1 AND role IN ('staff', 'agent', 'admin', 'super_admin')`,
                [agentIdInt]
            );
            if (agent.rows.length === 0) {
                return res.status(400).json({ error: 'Agent not found or invalid role' });
            }
        }

        await pool.query(
            'UPDATE chat_topics SET assigned_agent_id = $1 WHERE topic_id = $2',
            [agentIdInt, topic_id]
        );

        res.json({ success: true, assigned_agent_id: agentIdInt });
    } catch (err) {
        console.error('Assign error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== ADMIN USERS ====================
app.get('/api/admin/users', verifyToken, async (req, res) => {
    try {
        if (!['admin', 'super_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
        const result = await pool.query(
            `SELECT id, name, email, role, is_online, last_seen, created_date, status FROM users ORDER BY created_date DESC`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/online-users', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, is_online, last_seen FROM users WHERE is_online = true');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/search', verifyToken, async (req, res) => {
    try {
        const { q, userId } = req.query;
        if (!q) return res.json([]);
        const result = await pool.query(
            `SELECT cm.topic_id, ct.topic_name, ct.topic_icon, ct.topic_color, cm.message, cm.created_at
             FROM chat_messages cm
             JOIN chat_participants cp ON cp.topic_id = cm.topic_id
             JOIN chat_topics ct ON ct.topic_id = cm.topic_id
             WHERE cp.user_uid = $1 AND cm.message ILIKE $2
             ORDER BY cm.created_at DESC LIMIT 30`,
            [String(userId), `%${q}%`]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== SUMMARY REPORTS ====================
app.get('/api/summary/reports', verifyToken, async (req, res) => {
    try {
        if (!['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const pending = await pool.query(`SELECT id, date_created, brand, title, description, 
                   'Pending Report' as category, 'Pending' as status, NULL as date_solved, NULL as date_completed FROM pending_reports`);
        const solved = await pool.query(`SELECT id, date_created, date_solved, brand, title, description, 
                   'Solved Report' as category, 'Solved' as status, date_solved, NULL as date_completed FROM solved_reports`);
        const maintenance = await pool.query(`SELECT id, date_created, provider as brand, title, description, 
                   'Pending Maintenance' as category, 'Maintenance' as status, NULL as date_solved, NULL as date_completed FROM maintenance_reports`);
        const solvedMaintenance = await pool.query(`SELECT id, date_created, date_completed, provider as brand, title, description, 
                   'Solved Maintenance' as category, 'Maintenance Solved' as status, NULL as date_solved, date_completed FROM solved_maintenance`);
        const agentIdeas = await pool.query(`SELECT id, date_created, brand, title, description, 
                   'Agent Ideas' as category, 'Released' as status, NULL as date_solved, NULL as date_completed FROM agent_ideas`);
        const eventProvider = await pool.query(`SELECT id, date_created, provider as brand, title, description, 
                   'Event Provider' as category, 'Released' as status, NULL as date_solved, NULL as date_completed FROM event_providers`);
        const allReports = [...pending.rows, ...solved.rows, ...maintenance.rows, ...solvedMaintenance.rows, ...agentIdeas.rows, ...eventProvider.rows];
        const reportsWithResolution = allReports.map(report => {
            let resolutionTime = 0;
            if (report.category === 'Solved Report' && report.date_solved) {
                const start = new Date(report.date_created);
                const end = new Date(report.date_solved);
                resolutionTime = Math.max(0, Math.round((end - start) / (1000 * 60)));
            } else if (report.category === 'Solved Maintenance' && report.date_completed) {
                const start = new Date(report.date_created);
                const end = new Date(report.date_completed);
                resolutionTime = Math.max(0, Math.round((end - start) / (1000 * 60)));
            }
            return { ...report, resolutionTime };
        });
        res.json(reportsWithResolution);
    } catch (err) {
        console.error('Error fetching summary reports:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== PENDING REPORTS CRUD ====================
app.get('/api/pending-reports', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM pending_reports ORDER BY date_created DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching pending reports:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/pending-reports/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM pending_reports WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching pending report:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/pending-reports', verifyToken, async (req, res) => {
    try {
        const { title, category, brand, dueDate, description, screenshotUrl } = req.body;
        if (!title || !category || !brand || !dueDate || !description) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const ticketId = generateTicketId();
        const result = await pool.query(
            `INSERT INTO pending_reports (id, title, category, brand, due_date, description, screenshot_url, user_id, status, date_created)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()) RETURNING *`,
            [ticketId, title, category, brand, dueDate, description, screenshotUrl || null, req.user.id, 'pending']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating pending report:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/pending-reports/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, category, brand, dueDate, description, screenshotUrl } = req.body;
        const result = await pool.query(
            `UPDATE pending_reports 
             SET title = $1, category = $2, brand = $3, due_date = $4, description = $5, screenshot_url = $6, date_updated = NOW()
             WHERE id = $7 RETURNING *`,
            [title, category, brand, dueDate, description, screenshotUrl || null, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating pending report:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/pending-reports/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM pending_reports WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting pending report:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/pending-reports/:id/complete', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { resolutionDescription } = req.body;
        if (!resolutionDescription) return res.status(400).json({ error: 'Resolution description required' });
        const pending = await pool.query('SELECT * FROM pending_reports WHERE id = $1', [id]);
        if (pending.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
        const report = pending.rows[0];
        await pool.query(
            `INSERT INTO solved_reports (id, title, category, brand, description, screenshot_url, user_id, reported_by, due_date, date_created, date_solved, resolution, completed_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11, $12)`,
            [id, report.title, report.category, report.brand, report.description, report.screenshot_url,
             report.user_id, report.reported_by || req.user.name, report.due_date, report.date_created,
             resolutionDescription, req.user.name || 'System']
        );
        await pool.query('DELETE FROM pending_reports WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error completing report:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== SOLVED REPORTS ====================
app.get('/api/solved-reports', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM solved_reports ORDER BY date_solved DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching solved reports:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/solved-reports/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM solved_reports WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching solved report:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/solved-reports/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM solved_reports WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting solved report:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/solved-reports/:id/reopen', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const solved = await pool.query('SELECT * FROM solved_reports WHERE id = $1', [id]);
        if (solved.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
        const report = solved.rows[0];
        const existing = await pool.query('SELECT id FROM pending_reports WHERE id = $1', [id]);
        let newId = id;
        if (existing.rows.length > 0) {
            newId = generateTicketId();
        }
        await pool.query(
            `INSERT INTO pending_reports (id, title, category, brand, due_date, description, screenshot_url, user_id, status, date_created, reported_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)`,
            [newId, report.title, report.category, report.brand, report.due_date, report.description,
             report.screenshot_url, report.user_id, report.date_created, report.reported_by]
        );
        await pool.query('DELETE FROM solved_reports WHERE id = $1', [id]);
        res.json({ success: true, newId });
    } catch (err) {
        console.error('Error reopening report:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/solved-reports', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query('DELETE FROM solved_reports RETURNING id');
        res.json({ success: true, deletedCount: result.rowCount });
    } catch (err) {
        console.error('Error deleting all solved reports:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== AGENT IDEAS ====================
app.get('/api/agent-ideas', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM agent_ideas ORDER BY date_created DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching agent ideas:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/agent-ideas/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM agent_ideas WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/agent-ideas', verifyToken, async (req, res) => {
    try {
        const { title, brand, status, description, resolution, imageUrl } = req.body;
        if (!title || !brand) return res.status(400).json({ error: 'Missing required fields' });
        const id = generateIdeaId();
        const userName = req.user.name || req.user.email?.split('@')[0] || 'User';
        const userEmail = req.user.email;
        const result = await pool.query(
            `INSERT INTO agent_ideas (id, title, brand, status, description, resolution, image_url, user_id, user_name, user_email, date_created, date_updated)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW()) RETURNING *`,
            [id, title, brand, status || 'pending', description || '', resolution || '', imageUrl || null,
             req.user.id, userName, userEmail]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating agent idea:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/agent-ideas/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, brand, status, description, resolution, imageUrl } = req.body;
        const result = await pool.query(
            `UPDATE agent_ideas SET
                title = COALESCE($1, title),
                brand = COALESCE($2, brand),
                status = COALESCE($3, status),
                description = COALESCE($4, description),
                resolution = COALESCE($5, resolution),
                image_url = COALESCE($6, image_url),
                date_updated = NOW()
             WHERE id = $7 RETURNING *`,
            [title, brand, status, description, resolution, imageUrl, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating agent idea:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/agent-ideas/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM agent_ideas WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting agent idea:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== MAINTENANCE REPORTS ====================
app.get('/api/maintenance', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM maintenance_reports ORDER BY date_created DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching maintenance tasks:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/maintenance/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM maintenance_reports WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/maintenance', verifyToken, async (req, res) => {
    try {
        const { title, category, provider, status, start_date, end_date, description, notes } = req.body;
        if (!title || !category || !provider || !status || !start_date || !end_date) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const ticketId = generateTicketId();
        const userName = req.user.name || req.user.email?.split('@')[0] || 'System';
        const result = await pool.query(
            `INSERT INTO maintenance_reports 
             (id, title, category, provider, status, start_date, end_date, description, notes, user_id, created_by, date_created, date_updated)
             VALUES ($1, $2, $3, $4, $5, $6::TIMESTAMPTZ, $7::TIMESTAMPTZ, $8, $9, $10, $11, NOW(), NOW()) RETURNING *`,
            [ticketId, title, category, provider, status, start_date, end_date, description || '', notes || '',
             req.user.id, userName]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating maintenance task:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/maintenance/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, category, provider, status, start_date, end_date, description, notes } = req.body;
        const result = await pool.query(
            `UPDATE maintenance_reports SET
                title = $1, category = $2, provider = $3, status = $4,
                start_date = $5::TIMESTAMPTZ, end_date = $6::TIMESTAMPTZ, description = $7, notes = $8,
                date_updated = NOW()
             WHERE id = $9 RETURNING *`,
            [title, category, provider, status, start_date, end_date, description, notes, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating maintenance task:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/maintenance/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM maintenance_reports WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting maintenance task:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/maintenance/:id/complete', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const task = await pool.query('SELECT * FROM maintenance_reports WHERE id = $1', [id]);
        if (task.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
        const t = task.rows[0];
        const userName = req.user.name || req.user.email?.split('@')[0] || 'System';
        await pool.query(
            `INSERT INTO solved_maintenance 
             (id, title, category, provider, status, start_date, end_date, description, notes, user_id, created_by, date_created, date_completed, completed_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13)`,
            [t.id, t.title, t.category, t.provider, 'completed', t.start_date, t.end_date,
             t.description, t.notes, t.user_id, t.created_by, t.date_created, userName]
        );
        await pool.query('DELETE FROM maintenance_reports WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error completing maintenance task:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== SOLVED MAINTENANCE ====================
app.get('/api/solved-maintenance', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM solved_maintenance ORDER BY date_completed DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching solved maintenance:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/solved-maintenance/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM solved_maintenance WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/solved-maintenance/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, category, provider, description, notes } = req.body;
        if (!title || !category) {
            return res.status(400).json({ error: 'Title and category are required' });
        }
        const result = await pool.query(
            `UPDATE solved_maintenance SET
                title = $1, category = $2, provider = $3,
                description = $4, notes = $5, date_updated = NOW()
             WHERE id = $6 RETURNING *`,
            [title, category, provider, description || '', notes || '', id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating solved maintenance:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/solved-maintenance/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM solved_maintenance WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting solved maintenance:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/solved-maintenance/:id/reopen', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const solved = await pool.query('SELECT * FROM solved_maintenance WHERE id = $1', [id]);
        if (solved.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
        const t = solved.rows[0];
        const existing = await pool.query('SELECT id FROM maintenance_reports WHERE id = $1', [id]);
        let newId = id;
        if (existing.rows.length > 0) {
            newId = generateTicketId();
        }
        await pool.query(
            `INSERT INTO maintenance_reports 
             (id, title, category, provider, status, start_date, end_date, description, notes, user_id, created_by, date_created, date_updated)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())`,
            [newId, t.title, t.category, t.provider, 'pending', t.start_date, t.end_date,
             t.description, t.notes, t.user_id, t.created_by, t.date_created]
        );
        await pool.query('DELETE FROM solved_maintenance WHERE id = $1', [id]);
        res.json({ success: true, newId });
    } catch (err) {
        console.error('Error reopening maintenance task:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== STAFF MANAGEMENT ====================
app.get('/api/staff', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query(
            `SELECT id, name, email, role, status, is_online, last_seen, created_date, profile_image 
             FROM users 
             WHERE role IN ('staff', 'agent', 'support', 'super_admin')
             ORDER BY created_date DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching staff:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/staff/stats', verifyToken, async (req, res) => {
    try {
        if (!['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const totalChatsToday = await pool.query(
            `SELECT COUNT(*) FROM chat_messages WHERE created_at >= $1 AND sender_role = 'user'`,
            [today]
        );

        const activeChats = await pool.query(
            `SELECT COUNT(*) FROM chat_topics WHERE last_message_time >= NOW() - INTERVAL '15 minutes'`
        );

        const waitingQueue = await pool.query(
            `SELECT COUNT(*) FROM chat_topics ct 
             WHERE ct.assigned_agent_id IS NULL 
               AND ct.last_message_time >= NOW() - INTERVAL '1 hour'`
        );

        const agentsOnline = await pool.query(
            `SELECT COUNT(*) FROM users WHERE is_online = true AND role IN ('staff', 'agent', 'admin', 'super_admin')`
        );

        const avgResponse = await pool.query(`
            WITH first_responses AS (
                SELECT 
                    cm.topic_id,
                    MIN(cm.created_at) as first_staff_response
                FROM chat_messages cm
                WHERE cm.sender_role = 'staff'
                GROUP BY cm.topic_id
            ),
            first_user_msgs AS (
                SELECT 
                    cm.topic_id,
                    MIN(cm.created_at) as first_user_msg
                FROM chat_messages cm
                WHERE cm.sender_role = 'user'
                GROUP BY cm.topic_id
            )
            SELECT AVG(EXTRACT(EPOCH FROM (fr.first_staff_response - fu.first_user_msg))) as avg_sec
            FROM first_responses fr
            JOIN first_user_msgs fu ON fr.topic_id = fu.topic_id
            WHERE fr.first_staff_response > fu.first_user_msg
              AND fr.first_staff_response >= $1
        `, [today]);

        const firstResponse = await pool.query(`
            WITH first_responses AS (
                SELECT 
                    cm.topic_id,
                    MIN(cm.created_at) as first_staff_response
                FROM chat_messages cm
                WHERE cm.sender_role = 'staff' AND cm.created_at >= $1
                GROUP BY cm.topic_id
            ),
            first_user_msgs AS (
                SELECT 
                    cm.topic_id,
                    MIN(cm.created_at) as first_user_msg
                FROM chat_messages cm
                WHERE cm.sender_role = 'user' AND cm.created_at >= $1
                GROUP BY cm.topic_id
            )
            SELECT AVG(EXTRACT(EPOCH FROM (fr.first_staff_response - fu.first_user_msg))) as avg_sec
            FROM first_responses fr
            JOIN first_user_msgs fu ON fr.topic_id = fu.topic_id
            WHERE fr.first_staff_response > fu.first_user_msg
        `, [today]);

        let csatScore = 0;
        try {
            const tableCheck = await pool.query(`SELECT to_regclass('customer_feedback')`);
            if (tableCheck.rows[0].to_regclass) {
                const csat = await pool.query(
                    `SELECT AVG(rating) as avg_csat FROM customer_feedback WHERE created_at >= $1`,
                    [today]
                );
                csatScore = Math.round((csat.rows[0]?.avg_csat || 0) * 10) / 10;
            }
        } catch (e) { /* table not exist */ }

        let solvedToday = 0;
        try {
            const solvedRes = await pool.query(
                `SELECT COUNT(*) FROM chat_topics WHERE resolved_at >= $1`,
                [today]
            );
            solvedToday = parseInt(solvedRes.rows[0].count);
        } catch (e) { /* column not exist */ }

        res.json({
            totalChatsToday: parseInt(totalChatsToday.rows[0].count),
            activeChats: parseInt(activeChats.rows[0].count),
            waitingQueue: parseInt(waitingQueue.rows[0].count),
            agentsOnline: parseInt(agentsOnline.rows[0].count),
            avgResponseTime: Math.round(avgResponse.rows[0]?.avg_sec || 0),
            firstResponseTime: Math.round(firstResponse.rows[0]?.avg_sec || 0),
            csatScore,
            solvedToday
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/staff/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { id } = req.params;
        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ error: 'Invalid staff ID' });
        }
        const result = await pool.query(
            `SELECT id, name, email, role, status, is_online, last_seen, created_date, profile_image 
             FROM users WHERE id = $1`,
            [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Staff not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching staff:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/staff/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { id } = req.params;
        if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid staff ID' });
        const { name, email, role, status } = req.body;
        if (!name || !email || !role || !status) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const allowedRoles = ['staff', 'agent', 'support', 'super_admin'];
        if (!allowedRoles.includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }
        const allowedStatus = ['active', 'suspended', 'pending'];
        if (!allowedStatus.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Staff not found' });
        }
        const result = await pool.query(
            `UPDATE users 
             SET name = $1, email = $2, role = $3, status = $4, last_updated = NOW()
             WHERE id = $5 RETURNING id, name, email, role, status`,
            [name, email, role, status, id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating staff:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/staff/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { id } = req.params;
        if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid staff ID' });
        if (req.user.id === parseInt(id)) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff not found' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting staff:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/staff/:id/reset-password', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { id } = req.params;
        if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid staff ID' });
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Staff not found' });
        }
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query(
            `UPDATE users SET password_hash = $1, last_updated = NOW() WHERE id = $2`,
            [hashedPassword, id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error resetting password:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== TOPUP CREDIT ====================
app.get('/api/credit-data', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM credit_data ORDER BY category');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching credit data:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/credit-data/:category', verifyToken, async (req, res) => {
    try {
        const { category } = req.params;
        const result = await pool.query('SELECT * FROM credit_data WHERE category = $1', [category]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Category not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error fetching credit data:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/credit-data/:category', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { category } = req.params;
        const { credit } = req.body;
        if (credit === undefined || credit < 0) {
            return res.status(400).json({ error: 'Invalid credit amount' });
        }
        const result = await pool.query(
            `UPDATE credit_data SET credit = $1, updated_at = NOW() WHERE category = $2 RETURNING *`,
            [credit, category]
        );
        if (result.rows.length === 0) {
            const insert = await pool.query(
                `INSERT INTO credit_data (category, credit, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING *`,
                [category, credit]
            );
            return res.json(insert.rows[0]);
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating credit data:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/topup-history', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM topup_history ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching topup history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/topup-history', verifyToken, async (req, res) => {
    try {
        const { brand, category, amount, before, after, user_name, user_email } = req.body;
        if (!brand || !category || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const result = await pool.query(
            `INSERT INTO topup_history (brand, category, amount, before_credit, after_credit, user_id, user_name, user_email, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING *`,
            [brand, category, amount, before || 0, after || 0, req.user.id, user_name || req.user.name, user_email || req.user.email]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating topup history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/topup-history/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { id } = req.params;
        const { brand, category, amount, before_credit, after_credit, date } = req.body;
        const result = await pool.query(
            `UPDATE topup_history SET
                brand = COALESCE($1, brand),
                category = COALESCE($2, category),
                amount = COALESCE($3, amount),
                before_credit = COALESCE($4, before_credit),
                after_credit = COALESCE($5, after_credit),
                date = COALESCE($6, date),
                updated_at = NOW()
             WHERE id = $7 RETURNING *`,
            [brand, category, amount, before_credit, after_credit, date, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'History not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating topup history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/topup-history/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { id } = req.params;
        const result = await pool.query('DELETE FROM topup_history WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'History not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting topup history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/topup-history', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query('DELETE FROM topup_history RETURNING id');
        res.json({ success: true, deletedCount: result.rowCount });
    } catch (err) {
        console.error('Error deleting all topup history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/masteragent-history', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM masteragent_history ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching masteragent history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/masteragent-history', verifyToken, async (req, res) => {
    try {
        const { category, amount, before, after, user_name, user_email } = req.body;
        if (!category || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const result = await pool.query(
            `INSERT INTO masteragent_history (category, amount, before_credit, after_credit, user_id, user_name, user_email, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING *`,
            [category, amount, before || 0, after || 0, req.user.id, user_name || req.user.name, user_email || req.user.email]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Error creating masteragent history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/masteragent-history/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { id } = req.params;
        const { category, amount, before_credit, after_credit, date } = req.body;
        const result = await pool.query(
            `UPDATE masteragent_history SET
                category = COALESCE($1, category),
                amount = COALESCE($2, amount),
                before_credit = COALESCE($3, before_credit),
                after_credit = COALESCE($4, after_credit),
                date = COALESCE($5, date),
                updated_at = NOW()
             WHERE id = $6 RETURNING *`,
            [category, amount, before_credit, after_credit, date, id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'History not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Error updating masteragent history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/masteragent-history/:id', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { id } = req.params;
        const result = await pool.query('DELETE FROM masteragent_history WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'History not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting masteragent history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/masteragent-history', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query('DELETE FROM masteragent_history RETURNING id');
        res.json({ success: true, deletedCount: result.rowCount });
    } catch (err) {
        console.error('Error deleting all masteragent history:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/regular-topup', verifyToken, async (req, res) => {
    try {
        const { brand, category, amount } = req.body;
        if (!brand || !category || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid data' });
        }
        if (amount > MAX_CREDIT_AMOUNT) {
            return res.status(400).json({ error: `Amount cannot exceed ${MAX_CREDIT_AMOUNT}` });
        }

        const creditResult = await pool.query(
            'SELECT * FROM credit_data WHERE category = $1',
            [category]
        );
        if (creditResult.rows.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const currentCredit = Number(creditResult.rows[0].credit);
        if (currentCredit < amount) {
            return res.status(400).json({ error: 'Insufficient credit' });
        }

        const newCredit = currentCredit - amount;
        if (newCredit < 0) {
            return res.status(400).json({ error: 'Insufficient credit' });
        }

        await pool.query(
            'UPDATE credit_data SET credit = $1, updated_at = NOW() WHERE category = $2',
            [newCredit, category]
        );

        const userName = req.user.name || req.user.email?.split('@')[0] || 'User';
        const histRes = await pool.query(
            `INSERT INTO topup_history (brand, category, amount, before_credit, after_credit, user_id, user_name, user_email, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) RETURNING *`,
            [brand, category, amount, currentCredit, newCredit, req.user.id, userName, req.user.email]
        );

        res.json({ success: true, history: histRes.rows[0], newCredit });
    } catch (err) {
        console.error('Error in regular topup:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/masteragent-topup', verifyToken, async (req, res) => {
    try {
        const { category, amount } = req.body;
        if (!category || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid data' });
        }

        const creditResult = await pool.query(
            'SELECT * FROM credit_data WHERE category = $1',
            [category]
        );
        if (creditResult.rows.length === 0) {
            return res.status(404).json({ error: 'Category not found' });
        }

        const currentCredit = Number(creditResult.rows[0].credit);
        const newCredit = currentCredit + amount;

        await pool.query(
            'UPDATE credit_data SET credit = $1, updated_at = NOW() WHERE category = $2',
            [newCredit, category]
        );

        const userName = req.user.name || req.user.email?.split('@')[0] || 'User';
        const histRes = await pool.query(
            `INSERT INTO masteragent_history (category, amount, before_credit, after_credit, user_id, user_name, user_email)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [category, amount, currentCredit, newCredit, req.user.id, userName, req.user.email]
        );

        res.json({ success: true, history: histRes.rows[0], newCredit });
    } catch (err) {
        console.error('Error in masteragent topup:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== TICKET SYSTEM ====================
app.get('/api/tickets', verifyToken, async (req, res) => {
    try {
        const { status, priority, assigned_to, user_id, search, limit = 50, offset = 0 } = req.query;
        let conditions = [];
        let params = [];
        let idx = 1;

        if (['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            if (status) { conditions.push(`t.status_id = $${idx++}`); params.push(status); }
            if (priority) { conditions.push(`t.priority_id = $${idx++}`); params.push(priority); }
            if (assigned_to === 'me') { conditions.push(`t.agent_id = $${idx++}`); params.push(req.user.id); }
            else if (assigned_to) { conditions.push(`t.agent_id = $${idx++}`); params.push(assigned_to); }
            if (user_id) { conditions.push(`t.user_id = $${idx++}`); params.push(user_id); }
            if (search) {
                conditions.push(`(t.title ILIKE $${idx++} OR t.description ILIKE $${idx++})`);
                params.push(`%${search}%`, `%${search}%`);
            }
        } else {
            conditions.push(`t.user_id = $${idx++}`);
            params.push(req.user.id);
            if (status) { conditions.push(`t.status_id = $${idx++}`); params.push(status); }
            if (search) {
                conditions.push(`(t.title ILIKE $${idx++} OR t.description ILIKE $${idx++})`);
                params.push(`%${search}%`, `%${search}%`);
            }
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const query = `
            SELECT t.*, 
                   u.name as user_name, u.email as user_email,
                   a.name as agent_name,
                   s.name as status_name, s.color as status_color,
                   p.name as priority_name, p.color as priority_color,
                   c.name as category_name
            FROM tickets t
            LEFT JOIN users u ON t.user_id = u.id
            LEFT JOIN users a ON t.agent_id = a.id
            LEFT JOIN ticket_status s ON t.status_id = s.id
            LEFT JOIN ticket_priority p ON t.priority_id = p.id
            LEFT JOIN ticket_category c ON t.category_id = c.id
            ${whereClause}
            ORDER BY t.created_at DESC
            LIMIT $${idx++} OFFSET $${idx++}
        `;
        params.push(limit, offset);
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Tickets error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tickets/from-chat', verifyToken, async (req, res) => {
    try {
        const { topicId, title, description, priority, category } = req.body;
        if (!topicId || !title) return res.status(400).json({ error: 'Topic ID and title required' });

        const topic = await pool.query('SELECT * FROM chat_topics WHERE topic_id = $1', [topicId]);
        if (topic.rows.length === 0) return res.status(404).json({ error: 'Topic not found' });

        const ticketId = 'TKT-' + Date.now().toString(36).toUpperCase();
        const result = await pool.query(
            `INSERT INTO tickets (id, topic_id, user_id, title, description, priority_id, category_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING *`,
            [ticketId, topicId, topic.rows[0].created_by, title, description || '', priority || 2, category || null]
        );
        await pool.query(`UPDATE chat_topics SET status = 'ticket', resolved_at = NOW() WHERE topic_id = $1`, [topicId]);

        try {
            await pool.query(
                `INSERT INTO activity_logs (user_id, action, target_type, target_id, details, created_at)
                 VALUES ($1, 'create_ticket', 'ticket', $2, $3, NOW())`,
                [req.user.id, ticketId, JSON.stringify({ title, from_chat: true })]
            );
        } catch (logErr) { /* activity_logs table might not exist */ }
        
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Create ticket error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== CANNED RESPONSES ====================
app.get('/api/canned-responses', verifyToken, async (req, res) => {
    try {
        const { category, search } = req.query;
        let conditions = [];
        let params = [];
        let idx = 1;
        
        if (['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            conditions.push(`(is_global = true OR created_by = $${idx++})`);
            params.push(req.user.id);
        } else {
            conditions.push(`is_global = true`);
        }
        
        if (category) { conditions.push(`category = $${idx++}`); params.push(category); }
        if (search) {
            conditions.push(`(title ILIKE $${idx++} OR content ILIKE $${idx++})`);
            params.push(`%${search}%`, `%${search}%`);
        }
        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const query = `SELECT * FROM canned_responses ${whereClause} ORDER BY title`;
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Canned responses error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/canned-responses', verifyToken, async (req, res) => {
    try {
        if (!['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { title, content, category, tags, is_global = false } = req.body;
        if (!title || !content) return res.status(400).json({ error: 'Title and content required' });
        const result = await pool.query(
            `INSERT INTO canned_responses (title, content, category, tags, created_by, is_global, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
            [title, content, category || null, tags || [], req.user.id, is_global]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Create canned response error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== ACTIVITY LOGS ====================
app.get('/api/activity-logs', verifyToken, async (req, res) => {
    try {
        if (!['admin', 'super_admin', 'staff', 'agent'].includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { user_id, action, target_type, limit = 50, offset = 0 } = req.query;
        let conditions = [], params = [], idx = 1;
        if (user_id) { conditions.push(`user_id = $${idx++}`); params.push(user_id); }
        if (action) { conditions.push(`action = $${idx++}`); params.push(action); }
        if (target_type) { conditions.push(`target_type = $${idx++}`); params.push(target_type); }
        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const query = `
            SELECT al.*, u.name as user_name, u.email as user_email
            FROM activity_logs al
            LEFT JOIN users u ON al.user_id = u.id
            ${whereClause}
            ORDER BY al.created_at DESC
            LIMIT $${idx++} OFFSET $${idx++}
        `;
        params.push(limit, offset);
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Activity logs error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== KNOWLEDGE BASE ====================
app.get('/api/kb', verifyToken, async (req, res) => {
    try {
        const { category, search, limit = 20, offset = 0 } = req.query;
        let conditions = ['is_published = true'];
        let params = [], idx = 1;
        if (category) { conditions.push(`category = $${idx++}`); params.push(category); }
        if (search) {
            conditions.push(`(title ILIKE $${idx++} OR content ILIKE $${idx++})`);
            params.push(`%${search}%`, `%${search}%`);
        }
        const query = `
            SELECT * FROM knowledge_base
            WHERE ${conditions.join(' AND ')}
            ORDER BY created_at DESC
            LIMIT $${idx++} OFFSET $${idx++}
        `;
        params.push(limit, offset);
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error('KB error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/kb/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `UPDATE knowledge_base SET views = views + 1 WHERE id = $1 RETURNING *`,
            [id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Article not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error('KB detail error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== CUSTOMER FEEDBACK ====================
app.post('/api/feedback', verifyToken, async (req, res) => {
    try {
        const { topic_id, rating, comment } = req.body;
        if (!topic_id || !rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Topic ID and rating (1-5) required' });
        }
        const topic = await pool.query('SELECT assigned_agent_id, created_by FROM chat_topics WHERE topic_id = $1', [topic_id]);
        if (topic.rows.length === 0) return res.status(404).json({ error: 'Topic not found' });
        const agent_id = topic.rows[0].assigned_agent_id;
        const result = await pool.query(
            `INSERT INTO customer_feedback (topic_id, user_id, agent_id, rating, comment, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
            [topic_id, req.user.id, agent_id, rating, comment || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Feedback error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== GLOBAL ERROR HANDLER ====================
app.use((err, req, res, next) => {
    console.error('Unhandled route error:', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT} with Socket.io`);
    console.log(`   -> http://localhost:${PORT}`);
    console.log(`   -> http://127.0.0.1:${PORT}`);
    console.log(`📁 Database: ${process.env.DB_NAME || 'myproject'}`);
});
