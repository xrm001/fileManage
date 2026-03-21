require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 创建数据库连接池
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// 登录 API
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    // 验证输入
    if (!username || !password) {
        return res.json({
            success: false,
            message: '用户名或密码不能为空'
        });
    }

    try {
        // 查询数据库
        const [rows] = await pool.execute(
            'SELECT name, password FROM person WHERE name = ?',
            [username]
        );

        // 检查用户是否存在
        if (rows.length === 0) {
            return res.json({
                success: false,
                message: '用户名或密码不匹配，请重新输入！'
            });
        }

        const user = rows[0];

        // 比较密码（明文比较，生产环境建议使用 bcrypt 加密）
        if (user.password === password) {
            return res.json({
                success: true,
                message: '登录成功'
            });
        } else {
            return res.json({
                success: false,
                message: '用户名或密码不匹配，请重新输入！'
            });
        }

    } catch (error) {
        console.error('数据库查询错误:', error);
        return res.json({
            success: false,
            message: '服务器错误，请稍后重试'
        });
    }
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log(`数据库连接: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
});
