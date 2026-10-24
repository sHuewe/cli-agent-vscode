import * as esbuild from 'esbuild';
const watch = process.argv.includes('--watch');
const options = {entryPoints:['src/extension.ts'],bundle:true,platform:'node',format:'cjs',target:'node20',outfile:'dist/extension.js',external:['vscode'],sourcemap:true};
if (watch) { const context = await esbuild.context(options); await context.watch(); }
else await esbuild.build(options);
