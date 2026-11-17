import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT_DIR = process.cwd();
const SCRATCH_BUILD = 'C:/Users/alano/.gemini/antigravity-cli/brain/58d69d2c-b6b5-4a72-b596-e051d765e61a/scratch/lambda-build';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  console.log('1. Preparando directorio de empaquetado Linux x64 en:', SCRATCH_BUILD);
  ensureDir(SCRATCH_BUILD);

  const sharedPkgDir = path.join(SCRATCH_BUILD, 'shared-deps');
  ensureDir(sharedPkgDir);

  fs.writeFileSync(
    path.join(sharedPkgDir, 'package.json'),
    JSON.stringify(
      {
        name: 'lambda-deps',
        version: '1.0.0',
        type: 'module',
        dependencies: {
          postgres: '^3.4.5',
          sharp: '0.33.5',
          '@img/sharp-linux-x64': '0.33.5',
          '@img/sharp-libvips-linux-x64': '1.0.4',
        },
      },
      null,
      2
    )
  );

  console.log('2. Instalando sharp (linux-x64) y postgres...');
  execSync('npm install --os=linux --cpu=x64 --include=optional --force --omit=dev --no-audit --no-fund', {
    cwd: sharedPkgDir,
    stdio: 'inherit',
  });

  const functions = [
    {
      name: 'practicas-alan-fn1',
      src: path.join(ROOT_DIR, 'lambdas', 'fn1-post-scan', 'index.mjs'),
      zip: path.join(SCRATCH_BUILD, 'fn1.zip'),
      needsSharp: true,
      needsPostgres: true,
    },
    {
      name: 'practicas-alan-fn2',
      src: path.join(ROOT_DIR, 'lambdas', 'fn2-transform', 'index.mjs'),
      zip: path.join(SCRATCH_BUILD, 'fn2.zip'),
      needsSharp: true,
      needsPostgres: false,
    },
    {
      name: 'practicas-alan-fn3',
      src: path.join(ROOT_DIR, 'lambdas', 'fn3-webhook', 'index.mjs'),
      zip: path.join(SCRATCH_BUILD, 'fn3.zip'),
      needsSharp: false,
      needsPostgres: true,
    },
  ];

  for (const fn of functions) {
    console.log(`3. Empaquetando ${fn.name}...`);
    const stageDir = path.join(SCRATCH_BUILD, fn.name);
    fs.rmSync(stageDir, { recursive: true, force: true });
    ensureDir(stageDir);

    fs.copyFileSync(fn.src, path.join(stageDir, 'index.mjs'));
    fs.writeFileSync(
      path.join(stageDir, 'package.json'),
      JSON.stringify({ name: fn.name, version: '1.0.0', type: 'module' }, null, 2)
    );

    // Copiar node_modules necesarios
    fs.cpSync(
      path.join(sharedPkgDir, 'node_modules'),
      path.join(stageDir, 'node_modules'),
      { recursive: true }
    );

    if (fs.existsSync(fn.zip)) {
      fs.unlinkSync(fn.zip);
    }

    // Usar tar.exe nativo de Windows 10/11 (mucho más rápido que Compress-Archive y preserva rutas POSIX /)
    execSync(`tar -a -c -f "${fn.zip}" index.mjs package.json node_modules`, {
      cwd: stageDir,
      stdio: 'inherit',
    });

    const stat = fs.statSync(fn.zip);
    console.log(`   -> ${fn.zip} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  console.log('Empaquetado de las 3 Lambdas completado con éxito.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
