#!/usr/bin/env node
// @ts-check
/*
 * Uso: after-publish [carpeta-del-paquete]
 *
 * Códigos de salida:
 *   0 publicado en npm
 *   1 el workflow terminó sin éxito (failure, cancelled, etc.)
 *   2 se agotó el tiempo de espera
 *   3 error de configuración (package.json inválido, repositorio no reconocido, etc.)
 */

import { waitForPublish, describeError, EXIT_CODE } from '../after-publish.js';

waitForPublish(process.argv[2] ?? '.').then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(describeError(err)); process.exitCode = EXIT_CODE.configError; },
);
