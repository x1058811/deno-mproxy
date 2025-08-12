// 文件名: mproxy-deploy.js

const VERSION = "1.1-Deno-Deploy";

/**
 * 使用XOR密钥对数据块进行原地加密/解密。
 * @param {Uint8Array} data - 需要处理的数据。
 * @param {Uint8Array} key - XOR密钥。
 */
function xorData(data, key) {
    if (key.length === 0) return;
    for (let i = 0; i < data.length; i++) {
        data[i] ^= key[i % key.length];
    }
}

/**
 * 创建一个TransformStream，用于对流经的数据应用XOR操作。
 * @param {Uint8Array} key - XOR密钥。
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
function createXorTransformStream(key) {
    return new TransformStream({
        transform(chunk, controller) {
            xorData(chunk, key);
            controller.enqueue(chunk);
        },
    });
}

/**
 * 处理单个客户端连接。
 * @param {Deno.Conn} clientConn - 客户端TCP连接。
 * @param {object} options - 包含远程主机、端口和密钥的选项。
 * @param {string} options.remoteHost
 * @param {number} options.remotePort
 * @param {Uint8Array} options.xorKeyBytes
 */
async function handleConnection(clientConn, { remoteHost, remotePort, xorKeyBytes }) {
    const clientAddr = clientConn.remoteAddr.hostname;
    console.log(`[${clientAddr}] Connection received.`);

    try {
        // 1. 设置TCP_NODELAY以获得低延迟
        if (clientConn.setNoDelay) clientConn.setNoDelay(true);

        // 2. 读取客户端的初始请求 (例如 HTTP CONNECT)
        // 这一步对于建立隧道是必要的，即使我们不解析它。
        const initialBuffer = new Uint8Array(4096);
        const bytesRead = await clientConn.read(initialBuffer);
        if (bytesRead === null) {
            clientConn.close();
            return;
        }

        // 3. 发送伪装的HTTP 200响应，告知客户端隧道已建立
        const httpResponse = new TextEncoder().encode(
            "HTTP/1.1 200 Connection Established\r\nConnection: keep-alive\r\n\r\n"
        );
        await clientConn.write(httpResponse);

        // 4. 连接到由环境变量指定的远程目标服务器
        const remoteConn = await Deno.connect({
            hostname: remoteHost,
            port: remotePort,
        });
        if (remoteConn.setNoDelay) remoteConn.setNoDelay(true);

        console.log(`[${clientAddr}] -> Tunnel established to [${remoteHost}:${remotePort}]`);

        // 5. 使用流(Streams)和管道(pipeTo)高效地双向转发数据
        let clientToRemotePipe, remoteToClientPipe;

        if (xorKeyBytes.length > 0) {
            clientToRemotePipe = clientConn.readable
                .pipeThrough(createXorTransformStream(xorKeyBytes))
                .pipeTo(remoteConn.writable, { preventClose: true });

            remoteToClientPipe = remoteConn.readable
                .pipeThrough(createXorTransformStream(xorKeyBytes))
                .pipeTo(clientConn.writable, { preventClose: true });
        } else {
            clientToRemotePipe = clientConn.readable.pipeTo(remoteConn.writable, { preventClose: true });
            remoteToClientPipe = remoteConn.readable.pipeTo(clientConn.writable, { preventClose: true });
        }
        
        await Promise.race([clientToRemotePipe, remoteToClientPipe]);

    } catch (err) {
        if (!(err instanceof Deno.errors.ConnectionReset || err instanceof Deno.errors.BrokenPipe)) {
             console.error(`[${clientAddr}] Error during connection:`, err);
        }
    } finally {
        try {
            clientConn.close();
        } catch (_) { /* 忽略关闭错误 */ }
        console.log(`[${clientAddr}] Connection closed.`);
    }
}

// 主函数
async function main() {
    // --- 从环境变量读取配置 ---
    const listenPort = parseInt(Deno.env.get("PORT") || "8080"); // Deno Deploy 会设置 PORT
    const remoteHost = "xzq2021.dynv6.net";
    const remotePort = 1194;
    const xorKey = Deno.env.get("XOR_KEY") || ""; // 可选的XOR密钥

    // 移除了对 REMOTE_HOST 和 REMOTE_PORT 的环境变量检查，因为它们现在是硬编码的。
    
    const xorKeyBytes = new TextEncoder().encode(xorKey);

    // 启动监听服务
    const listener = Deno.listen({ port: listenPort });
    console.log(`mproxy.js ${VERSION} listening on internal port ${listenPort}`);
    console.log(`Forwarding all traffic to ${remoteHost}:${remotePort}`);
    if (xorKey) {
        console.log(`XOR obfuscation enabled.`);
    }

    // 接受新连接并异步处理
    for await (const conn of listener) {
        handleConnection(conn, { remoteHost, remotePort, xorKeyBytes });
    }
}

// 程序入口
if (import.meta.main) {
    main();
}