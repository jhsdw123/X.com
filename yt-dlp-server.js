#!/usr/bin/env node
// ─────────────────────────────────────────────────
// yt-dlp 래핑 로컬 헬퍼 서버
// subtitle.html에서 X(Twitter), YouTube, TikTok, Instagram 등
// 영상 URL을 다운로드받을 때 사용.
//
// 실행: node yt-dlp-server.js
// 엔드포인트:
//   GET  /health            → 헬스 체크
//   GET  /download?url=...  → URL의 영상을 다운로드하여 mp4로 응답
// ─────────────────────────────────────────────────

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 4747;
const TMP_DIR = path.join(os.tmpdir(), 'ytdlp-server');
const MAX_FILESIZE = '500M'; // 500MB 상한

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'X-Original-Filename, Content-Disposition');
}

// SSE로 진행률을 보내기 위한 헬퍼
function sseWrite(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer((req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const urlObj = new URL(req.url, `http://localhost:${PORT}`);

    // ── 헬스 체크 ──
    if (urlObj.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
    }

    // ── 영상 다운로드 (바이너리 응답) ──
    if (urlObj.pathname === '/download') {
        const videoUrl = urlObj.searchParams.get('url');
        if (!videoUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Missing url parameter');
        }

        // 간단한 URL 검증
        try {
            const parsed = new URL(videoUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('Only http/https URLs are allowed');
            }
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Invalid URL');
        }

        const id = crypto.randomBytes(8).toString('hex');
        const outputTemplate = path.join(TMP_DIR, `${id}.%(ext)s`);

        console.log(`[${new Date().toISOString()}] ⬇️  ${videoUrl}`);

        // yt-dlp 실행
        // -f: 포맷 선택 (mp4 우선, 없으면 최고 품질)
        // --merge-output-format mp4: 분리된 영상/오디오를 mp4로 합침
        // --no-playlist: 플레이리스트면 첫 영상만
        // --max-filesize: 용량 제한
        // --print after_move:filepath: 최종 파일 경로 출력
        const ytdlp = spawn('yt-dlp', [
            '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
            '--merge-output-format', 'mp4',
            '-o', outputTemplate,
            '--no-playlist',
            '--max-filesize', MAX_FILESIZE,
            '--no-warnings',
            '--print', 'after_move:filepath',
            videoUrl
        ]);

        let stderrBuf = '';
        let resolvedPath = '';
        let responded = false;

        ytdlp.stdout.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            for (const raw of lines) {
                const line = raw.trim();
                if (!line) continue;
                console.log('  stdout:', line);
                if (fs.existsSync(line)) {
                    resolvedPath = line;
                }
            }
        });

        ytdlp.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderrBuf += text;
            // 진행률 라인이 stderr로 오는 경우가 있음
            process.stderr.write(`  stderr: ${text}`);
        });

        ytdlp.on('error', (err) => {
            if (responded) return;
            responded = true;
            if (err.code === 'ENOENT') {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('yt-dlp not found. Install with: brew install yt-dlp');
            }
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Spawn error: ${err.message}`);
        });

        ytdlp.on('close', (code) => {
            if (responded) return;

            if (code !== 0) {
                responded = true;
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end(`yt-dlp failed (exit code ${code}):\n\n${stderrBuf}`);
            }

            // after_move:filepath 출력이 없으면 tmp 디렉터리에서 id 매칭 파일 찾기 (fallback)
            if (!resolvedPath || !fs.existsSync(resolvedPath)) {
                try {
                    const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(id));
                    if (files.length === 0) {
                        responded = true;
                        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                        return res.end('Output file not found. stderr:\n' + stderrBuf);
                    }
                    resolvedPath = path.join(TMP_DIR, files[0]);
                } catch (e) {
                    responded = true;
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    return res.end('Failed to locate output: ' + e.message);
                }
            }

            const ext = path.extname(resolvedPath).toLowerCase();
            const mimeMap = {
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.mkv': 'video/x-matroska',
                '.mov': 'video/quicktime',
                '.m4v': 'video/mp4'
            };
            const contentType = mimeMap[ext] || 'application/octet-stream';
            const basename = path.basename(resolvedPath);

            let stat;
            try {
                stat = fs.statSync(resolvedPath);
            } catch (e) {
                responded = true;
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                return res.end('Failed to stat output file: ' + e.message);
            }

            responded = true;
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': stat.size,
                'Content-Disposition': `attachment; filename="${encodeURIComponent(basename)}"`,
                'X-Original-Filename': encodeURIComponent(basename)
            });

            const stream = fs.createReadStream(resolvedPath);
            stream.pipe(res);

            const cleanup = () => {
                fs.unlink(resolvedPath, (err) => {
                    if (err) console.error('  ⚠️  cleanup failed:', err.message);
                });
            };
            stream.on('end', cleanup);
            stream.on('error', (err) => {
                console.error('  stream error:', err.message);
                try { res.end(); } catch (_) {}
                cleanup();
            });

            // 클라이언트가 연결을 끊으면 파일 정리
            req.on('close', () => {
                if (!stream.destroyed) stream.destroy();
            });

            console.log(`  ✅ sent ${basename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
        });

        // 요청이 중간에 끊기면 yt-dlp도 종료
        req.on('close', () => {
            if (!ytdlp.killed) ytdlp.kill('SIGTERM');
        });

        return;
    }

    // ── 기타 ──
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ yt-dlp-server listening on http://localhost:${PORT}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('엔드포인트:');
    console.log(`  GET http://localhost:${PORT}/health`);
    console.log(`  GET http://localhost:${PORT}/download?url=<video-url>`);
    console.log('');
    console.log('종료하려면 Ctrl+C');
    console.log('');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ 포트 ${PORT}가 이미 사용 중입니다. 기존 서버를 끄고 다시 시도하세요.`);
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
});
