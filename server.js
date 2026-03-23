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

// 文件列表查询 API
app.get('/api/files', async (req, res) => {
    const { 
        type, 
        page = 1, 
        pageSize = 20, 
        username, 
        keyword, 
        uploader, 
        dept, 
        startDate, 
        endDate 
    } = req.query;
    
    const pageNum = parseInt(page) || 1;
    const pageSizeNum = parseInt(pageSize) || 20;
    const offset = (pageNum - 1) * pageSizeNum;
    
    try {
        // 获取当前用户信息（class 和 dept_id）
        const [userRows] = await pool.execute(
            'SELECT id, class, dept_id, name FROM person WHERE name = ?',
            [username]
        );
        
        if (userRows.length === 0) {
            return res.json({ success: false, message: '用户不存在' });
        }
        
        const currentUser = userRows[0];
        const userClass = currentUser.class;
        const userDeptId = currentUser.dept_id;
        
        // 构建查询条件
        let whereClause = 'WHERE 1=1';
        const params = [];
        
        // 类型筛选
        if (type && type !== 'all') {
            const typeMap = {
                'word': 'Word',
                'excel': 'Excel',
                'ppt': 'PPT',
                'pdf': 'PDF',
                'image': '图片',
                '3d': '3D模型',
                'video': '视频',
                'audio': '音频',
                'other': '其他'
            };
            whereClause += ' AND f.type = ?';
            params.push(typeMap[type] || type);
        }
        
        // 关键词模糊搜索（文件名、描述）
        if (keyword) {
            whereClause += ' AND (f.file_name LIKE ? OR f.file_descrip LIKE ?)';
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
            whereClause += ' AND f.upload_time >= ?';
            params.push(`${startDate} 00:00:00`);
        }
        if (endDate) {
            whereClause += ' AND f.upload_time <= ?';
            params.push(`${endDate} 23:59:59`);
        }
        
        // 权限控制
        let allowedUserIds = [];
        if (userClass > 1) {
            // 查询同部门且 class > 当前用户 class 的人员
            const [authRows] = await pool.execute(
                'SELECT id FROM person WHERE dept_id = ? AND class > ?',
                [userDeptId, userClass]
            );
            allowedUserIds = authRows.map(row => row.id);
            // 加上当前用户自己
            allowedUserIds.push(currentUser.id);
            
            if (allowedUserIds.length === 0) {
                return res.json({ success: true, files: [], total: 0 });
            }
        }
        // class = 0 或 1 可以查看全部，不添加限制
        
        // 构建最终的 where 子句
        let finalWhereClause = whereClause;
        if (allowedUserIds.length > 0) {
            finalWhereClause += ` AND f.pers_id IN (${allowedUserIds.join(',')})`;
        }
        
        // 查询总数
        const countSql = `SELECT COUNT(*) as total FROM files f 
            JOIN person p ON f.pers_id = p.id 
            LEFT JOIN department d ON p.dept_id = d.id 
            ${finalWhereClause}`;
        const [countRows] = await pool.execute(countSql, params);
        const total = countRows[0].total;
        
        // 查询数据
        const dataSql = `SELECT 
                f.id,
                f.file_name,
                f.type,
                f.file_descrip,
                p.name as uploader,
                d.dept_name as department,
                f.size,
                f.upload_time,
                f.url
            FROM files f
            JOIN person p ON f.pers_id = p.id
            LEFT JOIN department d ON p.dept_id = d.id
            ${finalWhereClause}
            ORDER BY f.upload_time DESC
            LIMIT ${pageSizeNum} OFFSET ${offset}`;
        
        const [files] = await pool.execute(dataSql, params);
        
        res.json({
            success: true,
            files: files,
            total: total,
            page: pageNum,
            pageSize: pageSizeNum
        });
        
    } catch (error) {
        console.error('查询错误:', error);
        res.status(500).json({ success: false, message: '查询失败: ' + error.message });
    }
});

// 修改文件信息 API
app.put('/api/files/:id', async (req, res) => {
    const fileId = req.params.id;
    const { fileName, fileDescrip, fileType, username } = req.body;
    
    try {
        // 获取当前用户信息
        const [userRows] = await pool.execute(
            'SELECT id, class FROM person WHERE name = ?',
            [username]
        );
        if (userRows.length === 0) {
            return res.json({ success: false, message: '用户不存在' });
        }
        const currentUser = userRows[0];
        
        // 获取文件信息
        const [fileRows] = await pool.execute(
            'SELECT f.*, p.class as uploader_class FROM files f JOIN person p ON f.pers_id = p.id WHERE f.id = ?',
            [fileId]
        );
        if (fileRows.length === 0) {
            return res.json({ success: false, message: '文件不存在' });
        }
        const file = fileRows[0];
        
        // 权限检查：只有管理员(class=0或1)或文件上传者本人可以修改
        if (currentUser.class > 1 && file.pers_id !== currentUser.id) {
            return res.json({ success: false, message: '无权修改此文件' });
        }
        
        // 更新文件信息
        await pool.execute(
            'UPDATE files SET file_name = ?, file_descrip = ?, type = ? WHERE id = ?',
            [fileName, fileDescrip || null, fileType, fileId]
        );
        
        res.json({ success: true, message: '修改成功' });
        
    } catch (error) {
        console.error('修改错误:', error);
        res.status(500).json({ success: false, message: '修改失败: ' + error.message });
    }
});

// 删除文件 API
app.delete('/api/files/:id', async (req, res) => {
    const fileId = req.params.id;
    const { username } = req.query;
    
    try {
        // 获取当前用户信息
        const [userRows] = await pool.execute(
            'SELECT id, class FROM person WHERE name = ?',
            [username]
        );
        if (userRows.length === 0) {
            return res.json({ success: false, message: '用户不存在' });
        }
        const currentUser = userRows[0];
        
        // 获取文件信息
        const [fileRows] = await pool.execute(
            'SELECT f.*, p.class as uploader_class FROM files f JOIN person p ON f.pers_id = p.id WHERE f.id = ?',
            [fileId]
        );
        if (fileRows.length === 0) {
            return res.json({ success: false, message: '文件不存在' });
        }
        const file = fileRows[0];
        
        // 权限检查：只有管理员(class=0或1)或文件上传者本人可以删除
        if (currentUser.class > 1 && file.pers_id !== currentUser.id) {
            return res.json({ success: false, message: '无权删除此文件' });
        }
        
        // 从S3删除文件
        const urlParts = file.url.split('/');
        const s3Key = urlParts.slice(3).join('/');
        await s3.deleteObject({
            Bucket: S3_BUCKET_NAME,
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

// 启动服务器 - 仅本地运行
app.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
    console.log(`数据库连接: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
});
