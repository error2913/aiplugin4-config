// 本地静态服务（零依赖，Node 内置模块）。
//
// 为什么不用 `python -m http.server`：它**不发 Cache-Control**，
// 浏览器于是按"启发式缓存"（约 Last-Modified 之后 10% 的时间）决定要不要复用旧文件。
// 结果是：改了 app.js / styles.css，按 F5 却可能仍跑**旧代码** ——
// 表现为"我明明改了它却没生效"，极难排查（本轮就踩了：以为 Key 的修复没生效）。
//
// 这里对所有响应发 `Cache-Control: no-store`，开发期每次刷新都拿最新文件。
//
// 用法：
//   node serve.mjs            # 默认 8099
//   node serve.mjs 8080       # 指定端口
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 8099;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
    // 只服务本目录下的文件；拒绝越界路径
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) && abs !== path.join(root, 'index.html')) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 越界');
        return;
    }

    fs.stat(abs, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            res.end('404 ' + urlPath);
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
            'Content-Length': st.size,
            // 关键：开发期一律不复用缓存
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
        });
        fs.createReadStream(abs).pipe(res);
    });
});

server.listen(port, '127.0.0.1', () => {
    console.log(`配置生成器已启动: http://127.0.0.1:${port}/`);
    console.log('（响应带 Cache-Control: no-store，刷新必定拿到最新文件）');
});
