# Meshkeep

[English](README.md) · **Español**

Aloja webs estáticas en una red peer-to-peer: direcciones gratuitas, sin servidores que alquilar y sin un punto único que alguien pueda apagar.

> **Estado: desarrollo temprano (v0.1).** La publicación, la replicación y las agendas funcionan de principio a fin y están probadas contra nodos Kubo reales. Las interfaces y los formatos aún pueden cambiar. Usa solo claves desechables y contenido público.

## La Idea

- **Tu dirección es una clave.** `meshkeep key create blog` te da una dirección como `k51qzi5uqu5d…`. Nadie te la vende, nadie te la puede quitar y no cuesta nada.
- **Tu web se identifica por su contenido.** Cada versión es un directorio IPFS inmutable identificado por su hash. Quien tenga una copia puede servirla, y cada visitante puede comprobar que los bytes son correctos.
- **Cualquiera puede mantenerla viva.** Las réplicas, que son máquinas de otras personas, guardan una copia completa y mantienen en circulación el registro firmado de tu dirección. Cuando las réplicas la tienen, la web sigue en pie aunque tu ordenador desaparezca, igual que un torrent sobrevive a quien lo empezó a compartir.
- **La gente usa nombres, no hashes.** Cada persona tiene una agenda (`book add blog k51…`) que asocia sus propios apodos a direcciones. Las agendas se pueden compartir e importar. Está prevista una extensión de navegador que funcione como una lista de contactos.

No hay blockchain, ni tokens, ni registro central, ni servidor de Meshkeep. Por debajo, [Kubo](https://github.com/ipfs/kubo) (IPFS) se encarga del almacenamiento, la transferencia y los nombres firmados. Meshkeep aporta el flujo de trabajo, las reglas y la agenda.

Meshkeep **no** es anónimo: los nodos pueden ver la IP de los nodos con los que hablan. Tampoco garantiza la permanencia (una web vive mientras alguien la replique) ni el borrado (las copias no se pueden retirar). Consulta [el modelo de amenazas](docs/threat-model.md).

## Inicio Rápido

Necesitas Node.js 22.12 o posterior, pnpm y un daemon de [Kubo](https://docs.ipfs.tech/install/command-line/) en marcha cuya API RPC escuche en `127.0.0.1:5001`.

```sh
pnpm install && pnpm build
alias meshkeep="node $PWD/packages/cli/dist/bin.js"

# Una vez por nodo Kubo: el perfil de importación que hace reproducibles las versiones.
ipfs config profile apply unixfs-v1-2025   # después reinicia el daemon
meshkeep doctor
```

Publicar una web:

```sh
meshkeep key create blog                 # muestra tu dirección, k51…
meshkeep publish ./public --key blog     # importa, fija y firma la v1
# edita ./public y vuelve a publicar: misma dirección, versión nueva
```

Replicar la web de otra persona, con un petname:

```sh
meshkeep book add su-blog k51qzi5uqu5d…
meshkeep replicate su-blog               # copia completa + mantiene viva la dirección
meshkeep replica run                     # se queda en marcha: revisa cada web cada 6 horas
```

En lugar de `replica run`, puedes ejecutar `meshkeep sync` desde cron al menos cada 12 horas. O montar una réplica completa, Kubo incluido, con Docker: `cd examples/docker && docker compose up -d` descarga la imagen publicada (`ghcr.io/ericpastorm/meshkeep`, amd64 y arm64) y Kubo (consulta la [guía de operador](docs/operators.md#run-a-replica-with-docker)).

Las réplicas solo descargan lo que han aceptado guardar. Cada web tiene un límite de tamaño y de bloques (por defecto 2 GiB y 250.000 bloques). Se ajusta con `replicate --max-size 512MiB --max-blocks 50000`; el valor se recuerda y `sync` lo aplica. Las versiones que superan el límite se rechazan y no se fijan. Una descarga interrumpida o que agota el tiempo (`--fetch-timeout`, 30 minutos por defecto) no registra nada, y la siguiente ejecución continúa desde los bloques ya descargados.

Todas las versiones se conservan salvo que decidas otra cosa: `replicate --keep 3` mantiene las tres versiones más recientes (y `sync` lo recuerda), y `meshkeep unreplicate su-blog` deja de seguir una web. En ambos casos solo se quitan los pins que puso la propia réplica, nunca uno que hayas puesto tú o `meshkeep publish` en el mismo nodo.

Ayuda a mantener en línea a toda una comunidad siguiendo la agenda publicada de un curador, igual que te suscribirías a una lista de torrents:

```sh
meshkeep book publish --key mi-lista     # curador: publica tu agenda como una web
meshkeep follow k51…curador              # réplica: replica todas las webs que lista, y se mantiene al día
meshkeep unfollow k51…curador            # deja de seguirla y libera las webs que solo quería esa agenda
```

`sync` y `replica run` recogen los cambios del curador. Las webs que la agenda deja de listar se dejan de replicar, salvo que las repliques tú mismo o que las liste otra agenda que sigues. `--max-sites` (100 por defecto) y los límites por web acotan lo que un curador te puede pedir. Consulta el [ADR 0003](docs/adr/0003-published-address-books.md).

Visita una web a través del gateway de cualquier nodo Kubo: `http://127.0.0.1:8080/ipns/k51…/`.

Mover la publicación a otra máquina:

```sh
meshkeep key export blog blog.key        # sin cifrar: muévelo por un canal seguro y bórralo después
# en la otra máquina:
meshkeep key import blog blog.key
meshkeep publish ./public --key blog     # continúa desde la última versión
```

Añade `--json` a cualquier comando para obtener salida legible por máquinas en stdout. Los diagnósticos van a stderr. Meshkeep guarda su estado en `$MESHKEEP_HOME` (por defecto `~/.config/meshkeep`).

¿Vas a operar un publicador o una réplica en serio? Lee la [guía de operador](docs/operators.md) (en inglés): configuración de Kubo, copia de seguridad de claves, programación de `sync` con systemd o cron, espacio en disco y solución de problemas.

## Cómo Funciona

```text
publicador                        réplicas                         visitante
──────────                        ────────                         ─────────
directorio ─► CID UnixFS
clave ─► registro IPNS firmado ─► verifica firma + secuencia
                                  fija cada bloque, verifica offline
                                  vuelve a publicar el registro ─► resuelve la dirección
                                  sirve bloques ─────────────────► descarga + verifica por CID
```

La documentación técnica está en inglés: [arquitectura](docs/architecture.md), [especificación](spec/README.md) y [ADR 0002](docs/adr/0002-resilient-sites-and-address-book.md), que explica el porqué de las decisiones.

## Repositorio

```text
packages/protocol   direcciones, claves, petnames, agenda (TS puro, apto para navegador)
packages/kubo       cliente mínimo de la RPC de Kubo (solo loopback por defecto)
packages/cli        el comando meshkeep
spec/               reglas normativas, JSON Schema, fixtures de interoperabilidad
tests/integration   red Kubo privada en Docker, test del ciclo de vida completo
docs/               guía de operador, arquitectura, modelo de amenazas, privacidad, ADRs
examples/           web de demostración, réplica con Docker Compose, units de systemd para el daemon y el sync
Dockerfile          la imagen de meshkeep (Node.js + un único fichero), ejecuta el daemon de réplica
```

## Desarrollo

```sh
pnpm install
pnpm check              # lint, typecheck, tests unitarios, build
pnpm test:integration   # requiere Docker; arranca cinco contenedores Kubo en una red privada
```

El test de integración publica la v1 y la replica en dos réplicas; después apaga el publicador. Mueve la clave a un segundo publicador, publica la v2 y sincroniza. Por último apaga todos los publicadores y comprueba que un visitante completamente nuevo sigue pudiendo resolver y cargar la web solo desde las réplicas. También comprueba que se rechazan los registros manipulados y los intentos de volver a una versión anterior. Otros conjuntos de tests cubren los límites de tamaño y de bloques de las réplicas con una descarga interrumpida que se retoma después, el daemon de réplica y la imagen de contenedor (construida desde el repositorio y ejecutada junto a Kubo igual que en el compose).

## Hoja De Ruta

Lo siguiente: la extensión de navegador con la agenda y descarga verificada dentro del navegador. Consulta [ROADMAP.md](ROADMAP.md).

## Contribuir Y Seguridad

Lee [CONTRIBUTING.md](CONTRIBUTING.md) y el [Código de Conducta](CODE_OF_CONDUCT.md). Las vulnerabilidades se reportan en privado como se describe en [SECURITY.md](SECURITY.md). El código está bajo la [Mozilla Public License 2.0](LICENSE).
