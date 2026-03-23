require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const AWS = require('aws-sdk');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8080;

// 配置 AWS S3（从环境变量读取）
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

// 配置 multer 用于文件上传
const upload = multer({ storage: multer.memoryStorage() });

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
            message: '用户名和密码不能为空'
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

// 文件上传 API
app.post('/api/upload', upload.array('files'), async (req, res) => {
    const { username, files: filesJson } = req.body;
    const files = req.files;

    console.log('S3_BUCKET_NAME:', S3_BUCKET_NAME);

    if (!files || files.length === 0) {
        return res.json({ success: false, message: '请选择文件' });
    }

    // 解析前端发送的文件信息
    let fileInfos = [];
    try {
        fileInfos = JSON.parse(filesJson || '[]');
    } catch (e) {
        fileInfos = [];
    }
    
    try {
        // 获取用户信息
        const [userRows] = await pool.execute(
            'SELECT id FROM person WHERE name = ?',
            [username]
        );
        if (userRows.length === 0) {
            return res.json({ success: false, message: '用户不存在' });
        }
        const persId = userRows[0].id;

        const uploadResults = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const info = fileInfos[i] || {};
            const fileName = info.name || file.originalname;
            const fileType = info.type || 'other';
            const fileIntro = info.description || null;

            // 文件类型映射（英文key -> {id, 中文名称}）
            const typeMap = {
                'word': { id: 1, name: 'Word' },
                'excel': { id: 2, name: 'Excel' },
                'ppt': { id: 3, name: 'PPT' },
                'pdf': { id: 4, name: 'PDF' },
                'image': { id: 5, name: '图片' },
                '3d': { id: 6, name: '3D模型' },
                'video': { id: 7, name: '视频' },
                'audio': { id: 8, name: '音频' },
                'other': { id: 9, name: '其他' }
            };
            const typeInfo = typeMap[fileType] || typeMap['other'];
            const typeId = typeInfo.id;
            const typeName = typeInfo.name;

            // S3 key: 用户名/文件类型中文名/文件名
            const s3Key = `${username}/${typeName}/${fileName}`;

            // 上传到 S3
            const s3Params = {
                Bucket: S3_BUCKET_NAME,
                Key: s3Key,
                Body: file.buffer,
                ContentType: file.mimetype
            };

            const s3Result = await s3.upload(s3Params).promise();

            // 插入数据库（type 字段存储文件类型中文名）
            const [insertResult] = await pool.execute(
                'INSERT INTO files (file_name, type, file_descrip, pers_id, size, upload_time, url) VALUES (?, ?, ?, ?, ?, NOW(), ?)',
                [fileName, typeName, fileIntro, persId, file.size, s3Result.Location]
            );

            uploadResults.push({
                id: insertResult.insertId,
                fileName: fileName,
                url: s3Result.Location,
                size: file.size,
                uploadTime: new Date().toISOString()
            });
        }

        res.json({
            success: true,
            message: '上传成功',
            files: uploadResults
        });

    } catch (error) {
        console.error('上传错误:', error);
        res.status(500).json({ success: false, message: '上传失败: ' + error.message });
    }
});

// 启动服务器 - 仅本地运行
app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log(`数据库连接: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
});
