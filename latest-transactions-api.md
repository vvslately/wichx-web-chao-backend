# API: การซื้อครั้งล่าสุดแยกตาม Customer

## Endpoint
```
GET /api/admin/latest-transactions-by-customer
```

## คำอธิบาย
ดึงข้อมูลการซื้อล่าสุด (default 10 รายการ) ของแต่ละ customer_id พร้อมรายละเอียดสินค้าและข้อมูลผู้ซื้อ

## Authentication
- ต้องใช้ JWT Token (`authenticateToken`)
- ต้องมีสิทธิ์ `can_edit_products`

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 10 | จำนวนรายการซื้อล่าสุดที่ต้องการดึงต่อแต่ละ customer_id |

## Request Example

```http
GET /api/admin/latest-transactions-by-customer?limit=10
Authorization: Bearer YOUR_JWT_TOKEN
```

## Response Format

### Success Response (200 OK)

```json
{
  "success": true,
  "message": "Latest transactions by customer retrieved successfully",
  "data": [
    {
      "customer_id": "1001",
      "website_name": "death",
      "transactions": [
        {
          "id": 15,
          "bill_number": "BILL-20241020-001",
          "user_id": 25,
          "user_fullname": "สมชาย ใจดี",
          "user_email": "somchai@example.com",
          "total_price": 1500.00,
          "created_at": "2024-10-20T10:30:00.000Z",
          "products": [
            {
              "product_id": 42,
              "title": "Minecraft Premium",
              "image": "https://example.com/images/minecraft.jpg",
              "quantity": 1,
              "price": 500.00
            },
            {
              "product_id": 43,
              "title": "Discord Nitro",
              "image": "https://example.com/images/discord.jpg",
              "quantity": 2,
              "price": 500.00
            }
          ]
        },
        {
          "id": 14,
          "bill_number": "BILL-20241019-002",
          "user_id": 30,
          "user_fullname": "สมหญิง ดีมาก",
          "user_email": "somying@example.com",
          "total_price": 2500.00,
          "created_at": "2024-10-19T15:45:00.000Z",
          "products": [
            {
              "product_id": 55,
              "title": "Steam Wallet",
              "image": "https://example.com/images/steam.jpg",
              "quantity": 3,
              "price": 833.33
            }
          ]
        }
        // ... up to 10 transactions
      ]
    },
    {
      "customer_id": "1002",
      "website_name": "shop2",
      "transactions": [
        // ... transactions for customer_id 1002
      ]
    }
  ],
  "total_customers": 5,
  "limit_per_customer": 10
}
```

### Error Response (500)

```json
{
  "success": false,
  "error": "Internal server error",
  "message": "Error message details"
}
```

## ข้อมูลที่ได้รับ

### ระดับ Customer
- `customer_id`: รหัส customer
- `website_name`: ชื่อเว็บไซต์จาก auth_sites
- `transactions`: array ของรายการซื้อ

### ระดับ Transaction
- `id`: รหัสรายการซื้อ
- `bill_number`: เลขที่บิล
- `user_id`: รหัสผู้ใช้
- `user_fullname`: ชื่อผู้ซื้อ
- `user_email`: อีเมลผู้ซื้อ
- `total_price`: ยอดรวม (decimal)
- `created_at`: วันเวลาที่ทำรายการ (ISO 8601 format)
- `products`: array ของสินค้าในรายการ

### ระดับ Product (ภายใน products array)
- `product_id`: รหัสสินค้า
- `title`: ชื่อสินค้า
- `image`: URL รูปภาพสินค้า
- `quantity`: จำนวนที่ซื้อ
- `price`: ราคาต่อหน่วย (decimal)

## การทำงาน

1. ใช้ **Window Function (ROW_NUMBER)** เพื่อจัดอันดับรายการซื้อของแต่ละ customer_id ตามวันเวลา (ล่าสุดก่อน)
2. กรองเฉพาะรายการที่มีอันดับไม่เกิน limit ที่กำหนด
3. JOIN กับตาราง users, auth_sites, transaction_items และ products เพื่อดึงข้อมูลเพิ่มเติม
4. จัดกลุ่มข้อมูลตาม customer_id ใน application layer
5. ส่งกลับเป็น JSON พร้อมข้อมูลสรุป

## ตัวอย่างการใช้งาน

### ดึงข้อมูล 10 รายการล่าสุดต่อ customer (default)
```javascript
const response = await fetch('/api/admin/latest-transactions-by-customer', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
const data = await response.json();
```

### ดึงข้อมูล 20 รายการล่าสุดต่อ customer
```javascript
const response = await fetch('/api/admin/latest-transactions-by-customer?limit=20', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
const data = await response.json();
```

## หมายเหตุ

- API นี้ใช้ CTE (Common Table Expression) และ Window Function ซึ่งต้องใช้ MySQL 8.0 ขึ้นไป
- ข้อมูลจะเรียงตาม customer_id จากน้อยไปมาก และภายในแต่ละ customer จะเรียงตามวันเวลาจากล่าสุดไปเก่าสุด
- สำหรับ customer ที่มีรายการซื้อน้อยกว่า limit จะแสดงทั้งหมดที่มี

