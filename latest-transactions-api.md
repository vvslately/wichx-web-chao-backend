# API: การซื้อครั้งล่าสุด (Multi-Tenant)

## Endpoint
```
GET /api/latest-transactions-by-customer
```

## คำอธิบาย
ดึงข้อมูลการซื้อล่าสุด (default 10 รายการ) ของ customer ปัจจุบัน (ตาม subdomain) พร้อมรายละเอียดสินค้าและข้อมูลผู้ซื้อ

## Authentication
- **ไม่ต้อง login** - เปิดให้เข้าถึงได้แบบสาธารณะ (Public Access)
- รองรับ Multi-Tenant (ใช้ `req.customer_id` จาก subdomain)
- ทุกคนสามารถเข้าถึงได้

## Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | integer | 10 | จำนวนรายการซื้อล่าสุดที่ต้องการดึงต่อแต่ละ customer_id |

## Request Example

```http
GET /api/latest-transactions-by-customer?limit=10
Host: demo.localhost:3000
```

หรือสำหรับ production:
```http
GET /api/latest-transactions-by-customer?limit=10
Host: demo.yourdomain.com
```

## Response Format

### Success Response (200 OK)

```json
{
  "success": true,
  "message": "Latest transactions by customer retrieved successfully",
  "data": [
    {
      "customer_id": "1",
      "website_name": "demo",
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
    }
  ],
  "total_customers": 1,
  "limit_per_customer": 10
}
```

### Error Response (400 - Missing Customer Context)

```json
{
  "success": false,
  "message": "Customer context required"
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

1. ตรวจสอบ `req.customer_id` จาก subdomain (Multi-Tenant)
2. กรองข้อมูล transactions เฉพาะ customer_id ที่ล็อกอิน
3. ใช้ **Window Function (ROW_NUMBER)** เพื่อจัดอันดับรายการซื้อตามวันเวลา (ล่าสุดก่อน)
4. กรองเฉพาะรายการที่มีอันดับไม่เกิน limit ที่กำหนด
5. JOIN กับตาราง users, auth_sites, transaction_items และ products (พร้อมกรอง customer_id)
6. จัดกลุ่มข้อมูลตาม customer_id ใน application layer
7. ส่งกลับเป็น JSON พร้อมข้อมูลสรุป

## ตัวอย่างการใช้งาน

### ดึงข้อมูล 10 รายการล่าสุด (default)
```javascript
// ไม่ต้องส่ง Authorization header - จะดึงข้อมูลตาม customer_id ที่ได้จาก subdomain
const response = await fetch('/api/latest-transactions-by-customer');
const data = await response.json();
```

### ดึงข้อมูล 20 รายการล่าสุด
```javascript
const response = await fetch('/api/latest-transactions-by-customer?limit=20');
const data = await response.json();
```

### ทดสอบด้วย curl (localhost)
```bash
# Test with demo subdomain
curl -H "Host: demo.localhost:3000" \
  http://localhost:3000/api/latest-transactions-by-customer

# Test with test subdomain
curl -H "Host: test.localhost:3000" \
  http://localhost:3000/api/latest-transactions-by-customer?limit=20
```

## หมายเหตุ

- API นี้ใช้ CTE (Common Table Expression) และ Window Function ซึ่งต้องใช้ MySQL 8.0 ขึ้นไป
- รองรับ Multi-Tenant โดยใช้ subdomain เป็นตัวระบุ customer
- ผู้ใช้จะเห็นเฉพาะข้อมูล transactions ของ customer_id ตัวเอง (ตาม subdomain)
- ข้อมูลจะเรียงตามวันเวลาจากล่าสุดไปเก่าสุด
- สำหรับ customer ที่มีรายการซื้อน้อยกว่า limit จะแสดงทั้งหมดที่มี
- **ไม่ต้อง login** - เปิดให้เข้าถึงได้แบบสาธารณะ (Public Access)

## Multi-Tenant Support

API นี้รองรับ multi-tenant โดยอัตโนมัติ:
- ใช้ subdomain เป็นตัวระบุ customer (เช่น `demo.yourdomain.com`, `shop1.yourdomain.com`)
- แต่ละ customer จะเห็นเฉพาะข้อมูลของตัวเอง
- ไม่สามารถเข้าถึงข้อมูลของ customer อื่นได้

