# Spec check — literal key

TEST ONLY violation fixture: a literal API key must be caught.

```sh
curl -H "Authorization: Bearer sk-abcdef0123456789abcdef01" \
  https://api.example.com/v1/notes
```
