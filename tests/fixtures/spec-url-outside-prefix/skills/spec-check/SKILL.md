# Spec check — url outside prefix

TEST ONLY violation fixture: the URL is not under the declared /v1/ path prefix.

```sh
curl -H "Authorization: Bearer $EXAMPLE_API_KEY" \
  https://api.example.com/other/notes
```
