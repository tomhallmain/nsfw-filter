const path = require('path')
const CopyPlugin = require('copy-webpack-plugin')

const PATHS = {
    src: path.join(__dirname, '../src'),
    dist: path.join(__dirname, '../dist/src'),
    distRoot: path.join(__dirname, '../dist')
}

module.exports = {
    entry: {
        content: `${PATHS.src}/content/content.ts`,
        background: `${PATHS.src}/background/background.ts`,
        offscreen: `${PATHS.src}/background/offscreen.ts`,
        popup: `${PATHS.src}/popup/index.tsx`,
        options: `${PATHS.src}/options/index.tsx`,
    },
    output: {
        path: PATHS.dist,
        filename: '[name].js'
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/
            },
            // tfjs registers its backend flags and kernels via top-level
            // side-effect calls (e.g. ENV.registerFlag('CPU_HANDOFF_SIZE_THRESHOLD',
            // ...) in flags_webgl). webpack resolves @tensorflow to fesm bundles
            // whose filenames aren't in tfjs's per-file `sideEffects` whitelist, so
            // it marks those registrations dead and terser deletes them under
            // minification. The model then reads an unregistered flag at module
            // init and throws "no evaluation function found". Force side effects on.
            {
                test: /[\\/]node_modules[\\/]@tensorflow[\\/]/,
                sideEffects: true
            },
            {
                test: /\.(eot|png|svg|[ot]tf|woff2?)(\?v=\d+\.\d+\.\d+)?$/,
                type: 'asset/resource'
            }
        ]
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                { from: `${PATHS.src}/popup/popup.html`, to: PATHS.dist },
                { from: `${PATHS.src}/options/options.html`, to: PATHS.dist },
                { from: `${PATHS.src}/background/offscreen.html`, to: PATHS.dist },
                // TensorFlow.js WASM backend binaries, loaded via setWasmPaths()
                {
                    from: '*.wasm',
                    context: path.join(__dirname, '../node_modules/@tensorflow/tfjs-backend-wasm/dist'),
                    to: path.join(PATHS.distRoot, 'models')
                },
                // ORT Web runs from a classic <script> in offscreen.html, outside
                // the bundle. Its WASM loader needs both the .wasm and the .mjs
                // glue under wasmPaths; numThreads=1 at runtime avoids spawning
                // workers, which need SharedArrayBuffer.
                {
                    from: 'ort.wasm.min.js',
                    context: path.join(__dirname, '../node_modules/onnxruntime-web/dist'),
                    to: PATHS.dist
                },
                {
                    from: 'ort-wasm-simd-threaded.wasm',
                    context: path.join(__dirname, '../node_modules/onnxruntime-web/dist'),
                    to: path.join(PATHS.distRoot, 'models/onnx/ort')
                },
                {
                    from: 'ort-wasm-simd-threaded.mjs',
                    context: path.join(__dirname, '../node_modules/onnxruntime-web/dist'),
                    to: path.join(PATHS.distRoot, 'models/onnx/ort')
                },
                {
                    from: 'ort-wasm-simd-threaded.jsep.wasm',
                    context: path.join(__dirname, '../node_modules/onnxruntime-web/dist'),
                    to: path.join(PATHS.distRoot, 'models/onnx/ort')
                },
                {
                    from: 'ort-wasm-simd-threaded.jsep.mjs',
                    context: path.join(__dirname, '../node_modules/onnxruntime-web/dist'),
                    to: path.join(PATHS.distRoot, 'models/onnx/ort')
                },
            ],
        }),
    ],
    resolve: {
        extensions: [".js", ".ts", ".tsx"],
        alias: {
            // nsfwjs pulls in @nsfw-filter/gif-frames -> ndarray, which builds
            // typed-array constructors with `new Function` at import time. That
            // violates the Manifest V3 CSP (no 'unsafe-eval') and aborts the
            // offscreen document before it can register its message listener. We
            // never call nsfwjs.classifyGif (GIFs are classified from their static
            // <img> frame via predictImage), so the dependency is dead weight;
            // stub it out to keep the CSP eval-free.
            "@nsfw-filter/gif-frames": path.resolve(__dirname, 'gif-frames-stub.js'),
            // tfjs pins seedrandom 2.4.x, whose main entry runs `(0,eval)('this')`
            // at load: another 'unsafe-eval' violation that breaks the offscreen
            // document. Redirect bare `seedrandom` imports to an eval-free shim
            // that exposes only alea (the one API tfjs uses). The `$` keeps the
            // shim's own `seedrandom/lib/alea` require working.
            "seedrandom$": path.resolve(__dirname, 'seedrandom-shim.js')
        }
    },
}
