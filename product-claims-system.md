# ระบบการเคลมสินค้า (Product Claims System)

## ภาพรวม
ระบบการเคลมสินค้าสำหรับ multi-tenant ที่ใช้ `customer_id` แยกระบบแต่ละลูกค้า โดยลูกค้าสามารถยื่นเคลมสินค้าที่ซื้อผ่าน transaction และแอดมินสามารถจัดการสถานะเคลมได้

## โครงสร้างฐานข้อมูล

### ตาราง `product_claims`
```sql
CREATE TABLE `product_claims` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` varchar(100) NOT NULL, -- สำหรับ multi-tenant
  `user_id` int NOT NULL,               -- ลูกค้าที่ยื่นเคลม
  `transaction_id` int NOT NULL,        -- transaction ที่เกี่ยวข้อง
  `product_id` int NOT NULL,            -- สินค้าที่เคลม
  `product_price` decimal(10,2) NOT NULL, -- ราคาสินค้า ณ เวลาซื้อ
  `claim_reason` text NOT NULL,         -- สาเหตุหรือรายละเอียดการเคลมจากลูกค้า
  `admin_note` text DEFAULT NULL,       -- ข้อความจากแอดมิน
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_transaction_id` (`transaction_id`),
  KEY `idx_product_id` (`product_id`),
  KEY `idx_customer_id` (`customer_id`),
  CONSTRAINT `product_claims_fk_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `product_claims_fk_transaction` FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `product_claims_fk_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

## API Endpoints

### 1. ยื่นเคลมสินค้า
```
POST /api/claims
Authorization: Bearer <token>
Content-Type: application/json

{
  "transaction_id": 123,
  "product_id": 456,
  "claim_reason": "สินค้าไม่ทำงานตามที่ระบุ"
}
```

**Response:**
```json
{
  "success": true,
  "message": "ยื่นเคลมสำเร็จ",
  "data": {
    "claim_id": 789,
    "transaction_id": 123,
    "product_id": 456,
    "product_price": 299.00,
    "status": "pending"
  }
}
```

### 2. ดูรายการเคลมของลูกค้า
```
GET /api/claims?status=pending&page=1&limit=10
Authorization: Bearer <token>
```

**Query Parameters:**
- `status` (optional): pending, approved, rejected
- `page` (optional): หมายเลขหน้า (default: 1)
- `limit` (optional): จำนวนรายการต่อหน้า (default: 10)

**Response:**
```json
{
  "success": true,
  "message": "ดึงรายการเคลมสำเร็จ",
  "data": {
    "claims": [
      {
        "id": 789,
        "transaction_id": 123,
        "product_id": 456,
        "product_price": 299.00,
        "claim_reason": "สินค้าไม่ทำงานตามที่ระบุ",
        "admin_note": null,
        "status": "pending",
        "created_at": "2024-01-15T10:30:00.000Z",
        "updated_at": "2024-01-15T10:30:00.000Z",
        "bill_number": "TXN-2024-001",
        "product_title": "Software License",
        "product_image": "product.jpg"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 5,
      "pages": 1
    }
  }
}
```

### 3. ดูรายละเอียดเคลมเฉพาะ
```
GET /api/claims/789
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "ดึงรายละเอียดเคลมสำเร็จ",
  "data": {
    "id": 789,
    "transaction_id": 123,
    "product_id": 456,
    "product_price": 299.00,
    "claim_reason": "สินค้าไม่ทำงานตามที่ระบุ",
    "admin_note": "กำลังตรวจสอบ",
    "status": "pending",
    "created_at": "2024-01-15T10:30:00.000Z",
    "updated_at": "2024-01-15T10:30:00.000Z",
    "bill_number": "TXN-2024-001",
    "transaction_total": 299.00,
    "product_title": "Software License",
    "product_image": "product.jpg",
    "product_description": "Professional software license"
  }
}
```

### 4. ดูรายการซื้อขายที่สามารถเคลมได้
```
GET /api/claims/eligible-transactions?page=1&limit=10
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "ดึงรายการซื้อขายที่สามารถเคลมได้สำเร็จ",
  "data": {
    "transactions": [
      {
        "transaction_id": 123,
        "bill_number": "TXN-2024-001",
        "total_price": 299.00,
        "created_at": "2024-01-10T09:00:00.000Z",
        "products": [
          {
            "product_id": 456,
            "price": 299.00,
            "title": "Software License",
            "image": "product.jpg"
          }
        ]
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 3,
      "pages": 1
    }
  }
}
```

## Admin Endpoints

### 5. ดูรายการเคลมทั้งหมด (Admin)
```
GET /api/admin/claims?status=pending&page=1&limit=10
Authorization: Bearer <admin_token>
```

**Response:**
```json
{
  "success": true,
  "message": "ดึงรายการเคลมทั้งหมดสำเร็จ",
  "data": {
    "claims": [
      {
        "id": 789,
        "transaction_id": 123,
        "product_id": 456,
        "product_price": 299.00,
        "claim_reason": "สินค้าไม่ทำงานตามที่ระบุ",
        "admin_note": null,
        "status": "pending",
        "created_at": "2024-01-15T10:30:00.000Z",
        "updated_at": "2024-01-15T10:30:00.000Z",
        "bill_number": "TXN-2024-001",
        "product_title": "Software License",
        "product_image": "product.jpg",
        "user_name": "John Doe",
        "user_email": "john@example.com"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 15,
      "pages": 2
    }
  }
}
```

### 6. อัปเดตสถานะเคลม (Admin)
```
PUT /api/admin/claims/789
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "status": "approved",
  "admin_note": "ตรวจสอบแล้ว สินค้าปกติ"
}
```

**Response:**
```json
{
  "success": true,
  "message": "อัปเดตสถานะเคลมสำเร็จ",
  "data": {
    "claim_id": 789,
    "status": "approved",
    "admin_note": "ตรวจสอบแล้ว สินค้าปกติ"
  }
}
```

## สถานะเคลม (Claim Status)

- **pending**: รอการพิจารณา
- **approved**: อนุมัติเคลม
- **rejected**: ปฏิเสธเคลม

## ข้อกำหนดและข้อจำกัด

1. **Multi-tenant Support**: ระบบใช้ `customer_id` แยกระบบแต่ละลูกค้า
2. **สิทธิ์การเข้าถึง**: ลูกค้าสามารถดูและจัดการเคลมของตัวเองเท่านั้น
3. **การป้องกันการเคลมซ้ำ**: ไม่สามารถเคลมสินค้าเดียวกันใน transaction เดียวกันได้มากกว่า 1 ครั้ง
4. **การตรวจสอบสิทธิ์**: ต้องเป็นเจ้าของ transaction และสินค้าที่จะเคลม
5. **การเก็บราคา**: เก็บราคาสินค้า ณ เวลาซื้อเพื่อป้องกันการเปลี่ยนแปลงราคา

## การใช้งานใน Frontend

### ตัวอย่างการยื่นเคลม
```javascript
const submitClaim = async (transactionId, productId, reason) => {
  try {
    const response = await fetch('/api/claims', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        transaction_id: transactionId,
        product_id: productId,
        claim_reason: reason
      })
    });
    
    const result = await response.json();
    if (result.success) {
      console.log('เคลมสำเร็จ:', result.data);
    }
  } catch (error) {
    console.error('เกิดข้อผิดพลาด:', error);
  }
};
```

### ตัวอย่างการดึงรายการเคลม
```javascript
const getClaims = async (status = null, page = 1) => {
  try {
    const params = new URLSearchParams({ page });
    if (status) params.append('status', status);
    
    const response = await fetch(`/api/claims?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    const result = await response.json();
    if (result.success) {
      return result.data;
    }
  } catch (error) {
    console.error('เกิดข้อผิดพลาด:', error);
  }
};
```

## การจัดการข้อผิดพลาด

### Error Codes
- **400**: ข้อมูลไม่ครบถ้วนหรือไม่ถูกต้อง
- **401**: ไม่มีสิทธิ์เข้าถึง (Token ไม่ถูกต้อง)
- **403**: ไม่มีสิทธิ์ในการดำเนินการ
- **404**: ไม่พบข้อมูลที่ระบุ
- **500**: ข้อผิดพลาดของเซิร์ฟเวอร์

### ตัวอย่าง Error Response
```json
{
  "success": false,
  "message": "ไม่พบรายการซื้อขายที่ระบุ หรือไม่มีสิทธิ์ในการเคลม",
  "error": "Transaction not found or access denied"
}
```

## การทดสอบระบบ

### 1. ทดสอบการยื่นเคลม
```bash
curl -X POST http://localhost:3001/api/claims \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "transaction_id": 1,
    "product_id": 1,
    "claim_reason": "สินค้าไม่ทำงาน"
  }'
```

### 2. ทดสอบการดูรายการเคลม
```bash
curl -X GET "http://localhost:3001/api/claims?status=pending" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 3. ทดสอบการอัปเดตสถานะ (Admin)
```bash
curl -X PUT http://localhost:3001/api/admin/claims/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -d '{
    "status": "approved",
    "admin_note": "ตรวจสอบแล้ว"
  }'
```

## หมายเหตุ

- ระบบนี้รองรับ multi-tenant โดยใช้ `customer_id`
- การเคลมจะเก็บราคาสินค้า ณ เวลาซื้อเพื่อป้องกันการเปลี่ยนแปลงราคา
- แอดมินต้องมีสิทธิ์ `can_edit_orders` เพื่อจัดการเคลม
- ระบบป้องกันการเคลมซ้ำสำหรับสินค้าเดียวกันใน transaction เดียวกัน
