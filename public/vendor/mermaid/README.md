# mermaid（同梱ファイル）

会話や計画の ```` ```mermaid ```` ブロックを図にするため、[mermaid](https://github.com/mermaid-js/mermaid) の配布ファイルをそのまま同梱しています。
CDN から読み込むと、配信内容が差し替えられた場合にハブの画面と同じオリジンで任意のスクリプトが動いてしまうため、ハブのサーバから配信しています（理由と限界は [仕組み](../../../docs/architecture.md#mermaid-の同梱) を参照）。

| 項目 | 内容 |
|---|---|
| バージョン | 10.9.1 |
| 取得元 | npm レジストリの `mermaid@10.9.1`（`https://registry.npmjs.org/mermaid/-/mermaid-10.9.1.tgz`） |
| 同梱したファイル | tarball 内の `package/dist/mermaid.min.js`（単一ファイルで完結する UMD 版）と `package/LICENSE` を、変更せずに置いています |
| ライセンス | MIT（[LICENSE](LICENSE)） |
| ハッシュ | [SHA256SUMS](SHA256SUMS)。`npm test` で同梱ファイルと一致するかを確かめます |

ESM 版（`mermaid.esm.min.mjs`）は図の種類ごとに多数のチャンクを読み込むため、1 ファイルで完結する UMD 版を使っています。画面側（`public/md.js`）は、mermaid のブロックがあるときだけ `<script>` で読み込み、`window.mermaid` を使います。

## 更新手順

1. 作業用の空のディレクトリで tarball を取得し、npm レジストリが公開している integrity と一致することを確かめます。

   ```bash
   V=10.9.1   # 更新後のバージョン
   npm view mermaid@$V dist.integrity dist.shasum
   npm pack mermaid@$V
   echo "sha512-$(openssl dgst -sha512 -binary mermaid-$V.tgz | base64 -w0)"   # dist.integrity と比べる
   sha1sum mermaid-$V.tgz                                                     # dist.shasum と比べる
   ```

2. 一致したら展開し、`package/dist/mermaid.min.js` と `package/LICENSE` をこのディレクトリに上書きしてから、ハッシュを記録し直します。

   ```bash
   tar -xzf mermaid-$V.tgz
   cp package/dist/mermaid.min.js package/LICENSE <リポジトリ>/public/vendor/mermaid/
   cd <リポジトリ>/public/vendor/mermaid && sha256sum mermaid.min.js LICENSE > SHA256SUMS
   ```

3. この README のバージョンと取得元を書き換え、開発用ハブで mermaid の図が表示されることを確かめます。メジャーバージョンを上げる場合は、`public/md.js` で使っている API（`initialize` / `render`）と UMD 版の有無が変わっていないかも確認してください。
