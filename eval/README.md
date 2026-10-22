# eval fixtures

## `fixtures/test-lot.jpg` (synthetic fallback)

A 640x360 JPEG drawn by `eval/make_fixture.py` from the V1 ("North corner") outlines in
`seed/lots/test-lot.json`: grey asphalt, white stall lines, dark rectangles as cars in
A-02, A-03, A-06 and B-02. The seed uploads it as the reference image for every viewpoint
of `test-lot`. Regenerate after editing the lot JSON:

    uv run python eval/make_fixture.py

It is not a realistic photo; it only exercises the upload -> worker -> status pipeline.

## Adding the PKLot pair later

1. Put one PKLot image and its XML in `eval/fixtures/pklot/`
   (e.g. `UFPR04/Sunny/2012-12-11/2012-12-11_10_15_00.jpg` + `.xml`).
2. Convert it:

       uv run python seed/import_pklot.py eval/fixtures/pklot/<name>.jpg \
           eval/fixtures/pklot/<name>.xml --lot-id pklot-ufpr04 --name "UFPR04"

3. Copy the image to `eval/fixtures/pklot-ufpr04.jpg` and seed it:

       uv run python seed/seed.py --lot pklot-ufpr04

Rows are clustered by center y (a gap above 0.6 x median stall height starts a row),
labelled A, B, C... with stalls numbered left to right.
