---
name: prisma-queries
description: Prisma Client query patterns
user-invocable: false
---

# Prisma Queries Skill

Patterns for querying data with Prisma Client.

## Basic CRUD

### Create

```typescript
// Create single record
const user = await prisma.user.create({
  data: {
    email: 'john@example.com',
    name: 'John Doe',
  },
})

// Create with relations
const user = await prisma.user.create({
  data: {
    email: 'john@example.com',
    profile: {
      create: { bio: 'Hello!' },
    },
    posts: {
      create: [
        { title: 'First Post' },
        { title: 'Second Post' },
      ],
    },
  },
  include: {
    profile: true,
    posts: true,
  },
})

// Create many
const users = await prisma.user.createMany({
  data: [
    { email: 'user1@example.com' },
    { email: 'user2@example.com' },
  ],
  skipDuplicates: true,
})
```

### Read

```typescript
// Find by ID
const user = await prisma.user.findUnique({
  where: { id: userId },
})

// Find by unique field
const user = await prisma.user.findUnique({
  where: { email: 'john@example.com' },
})

// Find first matching
const user = await prisma.user.findFirst({
  where: { role: 'ADMIN' },
})

// Find many with conditions
const users = await prisma.user.findMany({
  where: {
    role: 'USER',
    createdAt: { gte: new Date('2024-01-01') },
  },
  orderBy: { createdAt: 'desc' },
  take: 10,
  skip: 0,
})

// Find or throw
const user = await prisma.user.findUniqueOrThrow({
  where: { id: userId },
})
```

### Update

```typescript
// Update by ID
const user = await prisma.user.update({
  where: { id: userId },
  data: { name: 'New Name' },
})

// Update many
const result = await prisma.user.updateMany({
  where: { role: 'GUEST' },
  data: { role: 'USER' },
})

// Upsert (create or update)
const user = await prisma.user.upsert({
  where: { email: 'john@example.com' },
  update: { name: 'John' },
  create: { email: 'john@example.com', name: 'John' },
})
```

### Delete

```typescript
// Delete by ID
const user = await prisma.user.delete({
  where: { id: userId },
})

// Delete many
const result = await prisma.user.deleteMany({
  where: { role: 'INACTIVE' },
})
```

## Filtering

### Comparison Operators

```typescript
const users = await prisma.user.findMany({
  where: {
    age: { equals: 30 },
    age: { not: 30 },
    age: { gt: 18 },
    age: { gte: 18 },
    age: { lt: 65 },
    age: { lte: 65 },
    age: { in: [18, 21, 30] },
    age: { notIn: [0, 1] },
  },
})
```

### String Filters

```typescript
const users = await prisma.user.findMany({
  where: {
    name: { contains: 'john' },
    name: { startsWith: 'J' },
    name: { endsWith: 'Doe' },
    email: { mode: 'insensitive' },  // Case-insensitive
  },
})
```

### Logical Operators

```typescript
const users = await prisma.user.findMany({
  where: {
    AND: [
      { role: 'USER' },
      { active: true },
    ],
  },
})

const users = await prisma.user.findMany({
  where: {
    OR: [
      { role: 'ADMIN' },
      { role: 'MODERATOR' },
    ],
  },
})

const users = await prisma.user.findMany({
  where: {
    NOT: { role: 'GUEST' },
  },
})
```

### Relation Filters

```typescript
// Filter by related records
const users = await prisma.user.findMany({
  where: {
    posts: {
      some: { published: true },
    },
  },
})

const users = await prisma.user.findMany({
  where: {
    posts: {
      every: { published: true },
    },
  },
})

const users = await prisma.user.findMany({
  where: {
    posts: {
      none: { published: false },
    },
  },
})

// Count related
const users = await prisma.user.findMany({
  where: {
    posts: {
      some: {},
    },
    _count: {
      posts: { gt: 5 },
    },
  },
})
```

## Relations

### Include

```typescript
// Include related records
const user = await prisma.user.findUnique({
  where: { id: userId },
  include: {
    posts: true,
    profile: true,
  },
})

// Nested include
const user = await prisma.user.findUnique({
  where: { id: userId },
  include: {
    posts: {
      include: {
        comments: true,
      },
    },
  },
})

// Filter included relations
const user = await prisma.user.findUnique({
  where: { id: userId },
  include: {
    posts: {
      where: { published: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    },
  },
})
```

### Select

```typescript
// Select specific fields
const user = await prisma.user.findUnique({
  where: { id: userId },
  select: {
    id: true,
    email: true,
    posts: {
      select: {
        id: true,
        title: true,
      },
    },
  },
})
```

### Relation Count

```typescript
const users = await prisma.user.findMany({
  include: {
    _count: {
      select: {
        posts: true,
        followers: true,
      },
    },
  },
})
```

## Aggregation

### Count

```typescript
const count = await prisma.user.count({
  where: { role: 'USER' },
})
```

### Aggregate

```typescript
const result = await prisma.order.aggregate({
  _count: { _all: true },
  _sum: { total: true },
  _avg: { total: true },
  _min: { total: true },
  _max: { total: true },
  where: { status: 'COMPLETED' },
})
```

### Group By

```typescript
const result = await prisma.order.groupBy({
  by: ['status'],
  _count: { _all: true },
  _sum: { total: true },
  orderBy: {
    _count: { _all: 'desc' },
  },
})

// With having
const result = await prisma.order.groupBy({
  by: ['userId'],
  _sum: { total: true },
  having: {
    total: { _sum: { gt: 1000 } },
  },
})
```

## Transactions

```typescript
// Interactive transaction
const result = await prisma.$transaction(async (tx) => {
  const user = await tx.user.create({
    data: { email: 'new@example.com' },
  })

  await tx.profile.create({
    data: { userId: user.id, bio: 'Hello' },
  })

  return user
})

// Batch transaction
const [user, post] = await prisma.$transaction([
  prisma.user.create({ data: { email: 'new@example.com' } }),
  prisma.post.create({ data: { title: 'New Post', authorId: 'existing-id' } }),
])
```

## Raw Queries

```typescript
// Raw query
const users = await prisma.$queryRaw`
  SELECT * FROM users WHERE role = ${role}
`

// Raw execute
await prisma.$executeRaw`
  UPDATE users SET status = 'active' WHERE id = ${userId}
`
```

## Integration

Used by:
- `database-developer` agent
- `fullstack-developer` agent

---

## Examples (DatiHub)

Patterns using DatiHub's schema (User, Flow, FlowStep, UserConversation, etc.)

### Flows with Steps

```typescript
// Get all active flows with their steps ordered
const flows = await prisma.flow.findMany({
  where: { isActive: true },
  include: {
    flowSteps: {
      orderBy: { stepIndex: 'asc' }
    }
  },
  orderBy: { name: 'asc' }
})
```

### Conversations by Channel

```typescript
// Reusable: get active conversations by channel
async function getActiveConversationsByChannel(channelType: ChannelType) {
  return prisma.userConversation.findMany({
    where: {
      channelType,
      status: 'in_progress'
    },
    include: {
      chatbotUser: true,
      flow: true
    }
  })
}

// Usage
const whatsappConversations = await getActiveConversationsByChannel('WHATSAPP')
```

### Aggregations (Count by Flow)

```typescript
// Count conversations per flow
const stats = await prisma.flow.findMany({
  include: {
    _count: {
      select: {
        conversations: {
          where: { status: 'in_progress' }
        }
      }
    }
  }
})

// Group by status
const byStatus = await prisma.userConversation.groupBy({
  by: ['status'],
  _count: { _all: true }
})
```

### Transaction: Create Flow with Initial Step

```typescript
// Create flow + first step in transaction
const newFlow = await prisma.$transaction(async (tx) => {
  const flow = await tx.flow.create({
    data: {
      name: 'Nuevo Flow',
      description: 'Descripción',
      status: 'draft',
      triggerType: 'manual',
      flowType: 'STANDARD'
    }
  })

  await tx.flowStep.create({
    data: {
      flowId: flow.id,
      stepIndex: 0,
      type: 'text',
      content: 'Bienvenido a nuestro flujo',
      messageFormat: 'plain'
    }
  })

  return flow
})
```

### Raw Query (Complex Stats)

```typescript
// SQL when Prisma can't handle it
const result = await prisma.$queryRaw`
  SELECT f.name, COUNT(uc.id) as total
  FROM "Flow" f
  LEFT JOIN "UserConversation" uc ON f.id = uc."flowId"
  WHERE uc.status = 'completed'
  GROUP BY f.id
  ORDER BY total DESC
  LIMIT 10
`
```
