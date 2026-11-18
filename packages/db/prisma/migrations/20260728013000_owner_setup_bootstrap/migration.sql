-- CreateTable
CREATE TABLE "auth_owner" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_owner_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_owner_singleton_check" CHECK ("id" = 'singleton')
);

-- CreateTable
CREATE TABLE "owner_setup_token" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "registrationChallenge" TEXT,
    "registrationChallengeExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_setup_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_owner_userId_key" ON "auth_owner"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "owner_setup_token_tokenHash_key" ON "owner_setup_token"("tokenHash");

-- Prevent concurrent setup-link commands from leaving multiple usable links.
CREATE UNIQUE INDEX "owner_setup_token_one_open_key"
ON "owner_setup_token" ((1))
WHERE "usedAt" IS NULL AND "supersededAt" IS NULL;

-- CreateIndex
CREATE INDEX "owner_setup_token_expiresAt_idx" ON "owner_setup_token"("expiresAt");

-- AddForeignKey
ALTER TABLE "auth_owner" ADD CONSTRAINT "auth_owner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
