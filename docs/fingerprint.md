# Canonicalización y fingerprints — team-ai/v1

Ambos lados (TL Control y Developer AI Kit) deben producir el mismo `contextHash` y evaluar `codeFingerprint` con el mismo algoritmo.

## JSON Canonicalization (RFC 8785 / JCS)

Implementación: `src/domain/canonical.ts`.

Reglas aplicadas a los artefactos `team-ai/v1`:

1. Objetos: claves ordenadas por unidad de código UTF-16 (orden lexicográfico de `Object.keys().sort()`).
2. Arrays: orden de elementos preservado.
3. Strings/números/booleanos/null: misma semántica que `JSON.stringify` para valores JSON finitos.
4. No se admiten `NaN`, `Infinity`, `undefined` ni referencias circulares.
5. `toJSON` no se invoca; serializar el objeto plano ya construido.

## `contextHash`

1. Clonar el objeto `work-context.json`.
2. Eliminar el campo `contextHash` (no se incluye en el input canónico).
3. Canonicalizar con JCS.
4. SHA-256 en hex minúscula del UTF-8 resultante.

## `codeFingerprint`

SHA-256 hex del manifiesto canónico:

```json
{
  "repoId": "...",
  "headSha": "...",
  "paths": [{ "path": "relative/posix", "sha256": "..." }]
}
```

`paths` ordenado por `path`. No incluir secretos ni el árbol completo innecesario; el kit documenta las rutas evaluadas.

Si TL Control no conoce el SHA actual del repo, el dashboard muestra «última evidencia reportada» y no afirma freshness.
