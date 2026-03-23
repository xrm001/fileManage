const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const AWS = require('aws-sdk');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 配置 AWS S3
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

// 配置 multer 用于文件上传
const upload = multer({ storage: multer.memoryStorage() });

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 提供静态文件（前端页面）
app.use(express.static(path.join(__dirname, 'frontend')));

// 根路径返回登录页面
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend/login.html'));
});

// 创建数据库连接池
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    ssl: {
        rejectUnauthorized: false  // AWS RDS 需要SSL连接
    }
});

// 监听连接错误，自动处理断开
pool.on('error', (err) => {
    console.error('数据库连接池错误:', err.message);
});

// 包装执行函数，自动处理连接断开重试
async function executeQuery(queryFunc) {
    let retries = 3;
    while (retries > 0) {
        try {
            return await queryFunc();
        } catch (error) {
            if (error.message.includes('closed state') && retries > 1) {
                console.log('数据库连接断开，正在重试...');
                retries--;
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                throw error;
            }
        }
    }
}

// 测试数据库连接
async function testConnection() {
    // 调试：打印环境变量（隐藏密码）
    console.log('🔧 数据库配置:');
    console.log('  Host:', process.env.DB_HOST);
    console.log('  Port:', process.env.DB_PORT);
    console.log('  User:', process.env.DB_USER);
    console.log('  Password:', process.env.DB_PASSWORD ? '已设置 (长度:' + process.env.DB_PASSWORD.length + ')' : '未设置');
    console.log('  Database:', process.env.DB_DATABASE);
    
    try {
        const connection = await pool.getConnection();
        console.log('✅ 数据库连接成功！');
        connection.release();
    } catch (error) {
        console.error('❌ 数据库连接失败:', error.message);
    }
}

// 登录API
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    // 验证输入
    if (!username || !password) {
        return res.json({
            success: false,
            message: '用户名和密码不能为空！'
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

        // 验证密码（明文比较，生产环境建议使用 bcrypt 加密）
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
        console.error('登录查询错误:', error);
        return res.status(500).json({
            success: false,
            message: '服务器内部错误，请稍后重试！'
        });
    }
});

// 健康检查API
app.get('/api/health', async (req, res) => {
    try {
        const connection = await pool.getConnection();
        connection.release();
        res.json({ status: 'OK', database: 'Connected' });
    } catch (error) {
        res.status(500).json({ status: 'Error', database: 'Disconnected', error: error.message });
    }
});

// 文件上传API
app.post('/api/upload', upload.array('files'), async (req, res) => {
    const { fileNames, fileTypes, fileIntros, username } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
        return res.json({ success: false, message: '请选择文件' });
    }

    // 处理数组参数
    const names = Array.isArray(fileNames) ? fileNames : [fileNames];
    const types = Array.isArray(fileTypes) ? fileTypes : [fileTypes];
    const intros = Array.isArray(fileIntros) ? fileIntros : [fileIntros];
    
    try {
        // 获取用户信息
        const [userRows] = await executeQuery(() => pool.execute(
            'SELECT id FROM person WHERE name = ?',
            [username]
        ));
        if (userRows.length === 0) {
            return res.json({ success: false, message: '用户不存在' });
        }
        const persId = userRows[0].id;

        const uploadResults = [];

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = names[i] || file.originalname;
            const fileType = types[i] || '其他';
            const fileIntro = intros[i] || null;

            // 获取文件类型ID
            const [typeRows] = await executeQuery(() => pool.execute(
                'SELECT id FROM type WHERE file_type = ?',
                [fileType]
            ));
            if (typeRows.length === 0) {
                return res.json({ success: false, message: '文件类型不存在: ' + fileType });
            }
            const typeId = typeRows[0].id;

            const s3Key = `${username}/${fileType}/${fileName}`;

            // 上传到S3
            const s3Params = {
                Bucket: process.env.S3_BUCKET_NAME,
                Key: s3Key,
                Body: file.buffer,
                ContentType: file.mimetype
            };

            const s3Result = await s3.upload(s3Params).promise();

            // 插入数据库
            const [insertResult] = await executeQuery(() => pool.execute(
                'INSERT INTO files (file_name, type_id, file_intro, pers_id, size, datetime, url) VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 8 HOUR), ?)',
                [fileName, typeId, fileIntro, persId, file.size, s3Result.Location]
            ));

            uploadResults.push({
                id: insertResult.insertId,
                fileName: fileName,
                url: s3Result.Location
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

// 文件列表查询API
app.get('/api/files', async (req, res) => {
    const { type, page = 1, pageSize = 100, username, keyword, uploader, dept, startDate, endDate } = req.query;
    
    // 转换为数字
    const pageNum = parseInt(page) || 1;
    const pageSizeNum = parseInt(pageSize) || 100;

    try {
        // 获取当前用户信息
        const [userRows] = await pool.execute(
            'SELECT id, identity FROM person WHERE name = ?',
            [username]
        );
        if (userRows.length === 0) {
            return res.json({ success: false, message: '用户不存在' });
        }
        const currentUser = userRows[0];
        const userIdentity = currentUser.identity;

        // 构建查询条件
        let whereClause = '';
        const params = [];

        // 类型过滤
        if (type && type !== 'all') {
            whereClause += ' AND t.file_type = ?';
            params.push(type);
        }

        // 关键词模糊搜索（文件名、描述）
        if (keyword) {
            whereClause += ' AND (f.file_name LIKE ? OR f.file_intro LIKE ?)';
            params.push(`%${keyword}%`, `%${keyword}%`);
        }

        // 上传人精准匹配
        if (uploader) {
            whereClause += ' AND p.name = ?';
            params.push(uploader);
        }

        // 部门精准匹配
        if (dept) {
            whereClause += ' AND d.dept_name = ?';
            params.push(dept);
        }

        // 上传时间范围
        if (startDate) {
            whereClause += ' AND f.datetime >= ?';
            params.push(`${startDate} 00:00:00`);
        }
        if (endDate) {
            whereClause += ' AND f.datetime <= ?';
            params.push(`${endDate} 23:59:59`);
        }

        // 权限过滤
        if (userIdentity > 0) {
            // 查询 identity >= 当前用户identity 的用户ID列表
            const [authRows] = await pool.execute(
                'SELECT id FROM person WHERE identity >= ?',
                [userIdentity]
            );
            const allowedUserIds = authRows.map(row => row.id);
            if (allowedUserIds.length > 0) {
                whereClause += ` AND f.pers_id IN (${allowedUserIds.join(',')})`;
            } else {
                // 如果没有允许的用户，返回空结果
                return res.json({ success: true, files: [], total: 0 });
            }
        }
        // identity = 0 可以查看全部，不添加限制

        console.log('查询文件列表:', { username, userIdentity, type, keyword, uploader, dept, startDate, endDate, pageNum, pageSizeNum });

        // 查询总数
        const countSql = `SELECT COUNT(*) as total FROM files f 
             JOIN type t ON f.type_id = t.id 
             JOIN person p ON f.pers_id = p.id
             LEFT JOIN department d ON p.dept_id = d.id
             WHERE 1=1 ${whereClause}`;
        console.log('countSql:', countSql);
        const [countRows] = await pool.execute(countSql, params);
        const total = countRows[0].total;
        console.log('查询结果总数:', total);

        // 查询数据
        const offset = (pageNum - 1) * pageSizeNum;
        const queryParams = [...params, pageSizeNum, offset];
        console.log('查询参数:', queryParams);
        
        const dataSql = `SELECT f.id, f.file_name, t.file_type, f.file_intro, 
                    p.name as uploader, d.dept_name as department, 
                    f.size, f.datetime, f.url
             FROM files f
             JOIN type t ON f.type_id = t.id
             JOIN person p ON f.pers_id = p.id
             LEFT JOIN department d ON p.dept_id = d.id
             WHERE 1=1 ${whereClause}
             ORDER BY f.datetime DESC
             LIMIT ? OFFSET ?`;
        console.log('dataSql:', dataSql);
        
        const [files] = await pool.query(dataSql, queryParams);

        res.json({
            success: true,
            files: files,
            total: total
        });

    } catch (error) {
        console.error('查询错误:', error);
        res.status(500).json({ success: false, message: '查询失败: ' + error.message });
    }
});

// 删除文件API
app.delete('/api/files/:id', async (req, res) => {
    const fileId = req.params.id;
    const { username } = req.query;

    try {
        // 获取当前用户信息
        const [userRows] = await pool.execute(
            'SELECT id, identity FROM person WHERE name = ?',
            [username]
        );
        if (userRows.length === 0) {
            return res.json({ success: false, message: '用户不存在' });
        }
        const currentUser = userRows[0];

        // 获取文件信息
        const [fileRows] = await pool.execute(
            'SELECT f.*, p.identity as uploader_identity FROM files f JOIN person p ON f.pers_id = p.id WHERE f.id = ?',
            [fileId]
        );
        if (fileRows.length === 0) {
            return res.json({ success: false, message: '文件不存在' });
        }
        const file = fileRows[0];

        // 权限检查：只有管理员(identity=0)或文件上传者本人可以删除
        if (currentUser.identity > 0 && file.pers_id !== currentUser.id) {
            return res.json({ success: false, message: '无权删除此文件' });
        }

        // 从S3删除文件
        const s3Key = file.url.split('/').pop();
        await s3.deleteObject({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: s3Key
        }).promise();

        // 从数据库删除记录
        await pool.execute('DELETE FROM files WHERE id = ?', [fileId]);

        res.json({ success: true, message: '删除成功' });

    } catch (error) {
        console.error('删除错误:', error);
        res.status(500).json({ success: false, message: '删除失败: ' + error.message });
    }
});

// 修改文件信息API
app.put('/api/files/:id', async (req, res) => {
    const fileId = req.params.id;
    const { fileName, fileIntro, fileType, username } = req.body;

    try {
        // 获取当前用户信息
        const [userRows] = await pool.execute(
            'SELECT id, identity FROM person WHERE name = ?',
            [username]
        );
        if (userRows.length === 0) {
            return res.json({ success: false, message: '用户不存在' });
        }
        const currentUser = userRows[0];

        // 获取文件信息
        const [fileRows] = await pool.execute(
            'SELECT f.*, p.identity as uploader_identity FROM files f JOIN person p ON f.pers_id = p.id WHERE f.id = ?',
            [fileId]
        );
        if (fileRows.length === 0) {
            return res.json({ success: false, message: '文件不存在' });
        }
        const file = fileRows[0];

        // 权限检查：只有管理员(identity=0)或文件上传者本人可以修改
        if (currentUser.identity > 0 && file.pers_id !== currentUser.id) {
            return res.json({ success: false, message: '无权修改此文件' });
        }

        // 获取文件类型ID
        const [typeRows] = await pool.execute(
            'SELECT id FROM type WHERE file_type = ?',
            [fileType]
        );
        if (typeRows.length === 0) {
            return res.json({ success: false, message: '文件类型不存在' });
        }
        const typeId = typeRows[0].id;

        // 更新文件信息（同时更新上传时间为当前时间）
        await pool.execute(
            'UPDATE files SET file_name = ?, file_intro = ?, type_id = ?, datetime = DATE_ADD(NOW(), INTERVAL 8 HOUR) WHERE id = ?',
            [fileName, fileIntro || null, typeId, fileId]
        );

        res.json({ success: true, message: '修改成功' });

    } catch (error) {
        console.error('修改错误:', error);
        res.status(500).json({ success: false, message: '修改失败: ' + error.message });
    }
});

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 服务器运行在 http://0.0.0.0:${PORT}`);
    testConnection();
});
