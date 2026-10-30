# Releasing

## Versioning

| Bump | When |
| --- | --- |
| `patch` | Bug fixes, docs, translations |
| `minor` | New features, backwards compatible |
| `major` | Breaking changes |

## Steps

```sh
npm test                          # smoke test must be green
npm version patch                 # bumps package.json and creates a tag
git push --follow-tags
npm publish --registry=https://registry.npmjs.org/
```

## Notes

- `npm publish` may need `--registry=https://registry.npmjs.org/` if this machine points at a mirror; mirrors can serve packages but cannot accept publishes.
- Publishing requires either 2FA enabled on the account, or a granular access token with the 2FA-bypass option. Prefer enabling 2FA.
- `prepublishOnly` runs the syntax check and the smoke test, so a broken build never reaches the registry.
- The npm page is a snapshot: README and screenshot changes only appear after the next publish.

## Marketplace listing

The plugin market does not accept submissions directly. Listings come from [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin): one YAML file per plugin under `data/plugins/`, named `<owner>__<repo>.yml`. Submit a PR that adds that single file; the list READMEs are generated from it.

Install priority in the market is: npm package, then a GitHub Release tarball, then the full source tree. Publishing to npm gives users the fastest install.
