---
"@detent/api": minor
---

Add early check run creation on PR open and equalize admin/owner permissions.
First GitHub admin on ownerless org now becomes owner automatically.
Includes atomic operations to prevent race conditions and composite index for performance.
