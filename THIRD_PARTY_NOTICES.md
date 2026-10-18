# Third-party notices

fast-changyi's own source and documentation are provided under the repository's MIT license. This does not replace the licenses of third-party dependencies.

The direct npm dependency is [ali-oss](https://github.com/ali-sdk/ali-oss), initially locked to version 6.23.0, under the MIT license. Copyright (c) ali-sdk and other contributors.

`npm ci` installs dependencies listed in `package-lock.json`; each dependency retains its own license and notices. The generated browser SDK is copied unchanged from the installed `ali-oss/dist` distribution. Its original copyright banner remains intact. The npm tarball omits the license file, so this repository preserves the [license from the v6.23.0 source tag](https://github.com/ali-sdk/ali-oss/blob/35fd762d8b1600aa1ece32ff2b75d284c2631358/LICENSE) in `licenses/ali-oss.LICENSE` and copies it alongside the SDK as `public/vendor/ali-oss.LICENSE`. Generated vendor artifacts and `node_modules` are not committed to this repository.

The desktop preview shows the original project's empty interface. External reference images, production file lists, downloaded academic papers, and unrelated third-party source archives are not redistributed.
